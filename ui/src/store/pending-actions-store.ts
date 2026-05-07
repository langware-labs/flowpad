import { AgenticProcess, ConnectionManager, isReadyForInput, type StatusBearingProcess } from '@sdk';
import { useMemo, useSyncExternalStore } from 'react';

/**
 * Pending Actions store.
 *
 * A "pending action" is an AgenticProcess that just transitioned into
 * ready-for-input state and is awaiting the user's response. Each transition
 * marks the process as pending for `PENDING_DURATION_MS` (120s); subsequent
 * ready transitions restart the clock. Expiration is timer-driven and
 * unconditional — interactions do not clear it early.
 *
 * Source of truth: ``isReadyForInput`` from the SDK, evaluated against the
 * raw entity payload on every WebSocket data op for AgenticProcess. The first
 * observation of a process never marks it pending — only the false→true edge
 * does, so already-ready tabs at app startup do not all glow.
 */

export interface PendingEntry {
  processId: string;
  projectId: string | null;
  expiresAt: number;
}

const PENDING_DURATION_MS = 120_000;
const TIMER_TICK_MS = 1_000;

const pending = new Map<string, PendingEntry>();
const lastReady = new Map<string, boolean>();
const listeners = new Set<() => void>();
let snapshot: ReadonlyArray<PendingEntry> = [];
let timer: ReturnType<typeof setInterval> | null = null;
let attached = false;

function rebuildSnapshot(): void {
  snapshot = Array.from(pending.values());
}

function emitDevLog(): void {
  if (!import.meta.env.DEV) return;
  const byProject = new Map<string, number>();
  for (const e of pending.values()) {
    const key = e.projectId ?? '<none>';
    byProject.set(key, (byProject.get(key) ?? 0) + 1);
  }
  const parts = Array.from(byProject.entries()).map(([k, v]) => `${k}:${v}`);
  console.debug(`[pending-actions] global=${pending.size}${parts.length ? ' ' + parts.join(' ') : ''}`);
}

function notify(): void {
  rebuildSnapshot();
  emitDevLog();
  for (const l of listeners) l();
}

function ensureTimer(): void {
  if (timer) return;
  timer = setInterval(() => {
    const now = Date.now();
    let dirty = false;
    for (const [id, entry] of pending) {
      if (entry.expiresAt <= now) {
        pending.delete(id);
        dirty = true;
      }
    }
    if (dirty) notify();
    if (pending.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  }, TIMER_TICK_MS);
}

function handleDataOp(typeIdStr: string, op: string, data: unknown): void {
  const prefix = `${AgenticProcess.type}-`;
  if (!typeIdStr.startsWith(prefix)) return;
  const id = typeIdStr.slice(prefix.length);

  if (op === 'delete') {
    lastReady.delete(id);
    if (pending.delete(id)) notify();
    return;
  }

  if (!data || typeof data !== 'object') return;
  const obj = data as {
    status?: string;
    worker_status?: string;
    session_id?: string | null;
    project_id?: string | null;
  };
  const view: StatusBearingProcess = {
    status: obj.status,
    worker_status: obj.worker_status,
    session_id: obj.session_id ?? null,
  };
  const ready = isReadyForInput(view);
  const prev = lastReady.get(id);
  lastReady.set(id, ready);

  // Only mark pending on the false→true edge. The first observation per
  // process never marks (prev === undefined), so app-startup state isn't
  // mistaken for a transition.
  if (prev === false && ready) {
    pending.set(id, {
      processId: id,
      projectId: obj.project_id ?? null,
      expiresAt: Date.now() + PENDING_DURATION_MS,
    });
    ensureTimer();
    notify();
  }
}

function attachOnce(): void {
  if (attached) return;
  attached = true;
  ConnectionManager.getInstance().on('on_data_op', handleDataOp);
}

function subscribe(onChange: () => void): () => void {
  attachOnce();
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

const getSnapshot = (): ReadonlyArray<PendingEntry> => snapshot;

export function isPending(processId: string | null | undefined): boolean {
  if (!processId) return false;
  return pending.has(processId);
}

export function useIsPending(processId: string | null | undefined): boolean {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useMemo(() => {
    if (!processId) return false;
    return snap.some((e) => e.processId === processId);
  }, [snap, processId]);
}

export function usePendingActions(): ReadonlyArray<PendingEntry> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function usePendingCountGlobal(): number {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return snap.length;
}

export function usePendingCountByProject(projectId: string | null | undefined): number {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const target = projectId ?? null;
  return useMemo(() => snap.filter((e) => e.projectId === target).length, [snap, target]);
}

export function usePendingSessionIds(projectId?: string | null): Set<string> {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useMemo(() => {
    if (projectId === undefined) return new Set(snap.map((e) => e.processId));
    const target = projectId ?? null;
    return new Set(snap.filter((e) => e.projectId === target).map((e) => e.processId));
  }, [snap, projectId]);
}
