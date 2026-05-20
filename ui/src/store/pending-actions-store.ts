import { AgenticProcess, isReadyForInput, type StatusBearingProcess } from '@sdk';
import { subscribeToEntityOps } from '@sdk/react/hooks';
import { useMemo, useSyncExternalStore } from 'react';

/**
 * Pending Actions store.
 *
 * "Pending action" semantics: a tab whose AgenticProcess is currently
 * ready-for-input AND whose server-stamped ``ready_for_input_since`` is
 * within the last `PENDING_DURATION_MS` (300s) AND the user has not yet
 * acknowledged that specific transition on this device.
 *
 * Source of truth for the *when* is the server (`ready_for_input_since`,
 * transcript mtime). The store no longer stamps `now` on first observation,
 * which is what caused a page-refresh to spuriously re-arm the glow for
 * every already-ready process — the user had already seen those transitions
 * pre-refresh.
 *
 * Ack state is persisted to localStorage as `{ processId → ackedReadyAt }`.
 * Glow fires iff `readyAt > ackedReadyAt`, so a refresh observes the same
 * server timestamp it dismissed before and stays quiet.
 */

export interface PendingEntry {
  processId: string;
  projectId: string | null;
  /** Server-provided wall time (ms) when the worker became ready-for-input. */
  readyAt: number;
}

export interface ProcessTracker {
  processId: string;
  projectId: string | null;
  status: string | undefined;
  workerStatus: string | undefined;
  ready: boolean;
  /** Wall time (ms) of the most recent observed status / worker_status change. */
  lastStatusChangedAt: number;
  /** Server-stamped epoch ms when the worker became ready-for-input. Null when not ready or unknown. */
  readyAt: number | null;
}

const PENDING_DURATION_MS = 300_000;
const TIMER_TICK_MS = 1_000;
const ACK_STORAGE_KEY = 'pending-actions-acks-v1';

const trackers = new Map<string, ProcessTracker>();
const listeners = new Set<() => void>();
let snapshot: ReadonlyArray<PendingEntry> = [];
let timer: ReturnType<typeof setInterval> | null = null;
let attached = false;

const ackedReadyAt: Map<string, number> = loadAcks();

function loadAcks(): Map<string, number> {
  try {
    if (typeof localStorage === 'undefined') return new Map();
    const raw = localStorage.getItem(ACK_STORAGE_KEY);
    if (!raw) return new Map();
    const obj = JSON.parse(raw) as Record<string, number>;
    return new Map(Object.entries(obj));
  } catch {
    return new Map();
  }
}

function persistAcks(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const obj: Record<string, number> = {};
    for (const [k, v] of ackedReadyAt) obj[k] = v;
    localStorage.setItem(ACK_STORAGE_KEY, JSON.stringify(obj));
  } catch {
    // best effort — quota / private mode
  }
}

function isCurrentlyPending(t: ProcessTracker, now: number): boolean {
  if (!t.ready || t.readyAt === null) return false;
  if (now - t.readyAt >= PENDING_DURATION_MS) return false;
  const acked = ackedReadyAt.get(t.processId);
  if (acked !== undefined && acked >= t.readyAt) return false;
  return true;
}

function rebuildSnapshot(now: number): boolean {
  const next: PendingEntry[] = [];
  for (const t of trackers.values()) {
    if (isCurrentlyPending(t, now)) {
      next.push({ processId: t.processId, projectId: t.projectId, readyAt: t.readyAt as number });
    }
  }
  const changed =
    next.length !== snapshot.length ||
    next.some((e) => !snapshot.find((s) => s.processId === e.processId && s.readyAt === e.readyAt));
  if (changed) {
    snapshot = next;
    return true;
  }
  return false;
}

function emitDevLog(): void {
  if (!import.meta.env.DEV) return;
  const byProject = new Map<string, number>();
  for (const e of snapshot) {
    const key = e.projectId ?? '<none>';
    byProject.set(key, (byProject.get(key) ?? 0) + 1);
  }
  const parts = Array.from(byProject.entries()).map(([k, v]) => `${k}:${v}`);
  console.debug(`[pending-actions] global=${snapshot.length}${parts.length ? ' ' + parts.join(' ') : ''}`);
}

function notify(): void {
  emitDevLog();
  for (const l of listeners) l();
}

function ensureTimer(): void {
  if (timer) return;
  timer = setInterval(() => {
    const now = Date.now();
    const anyReady = Array.from(trackers.values()).some((t) => t.ready && t.readyAt !== null);
    const changed = rebuildSnapshot(now);
    if (changed) notify();
    if (!anyReady && timer) {
      clearInterval(timer);
      timer = null;
    }
  }, TIMER_TICK_MS);
}

function handleDataOp(typeIdStr: string, op: string, data: unknown): void {
  // Type filtering is handled by `subscribeToEntityOps` in `attachOnce()` —
  // this callback is only invoked for AgenticProcess events.
  const prefix = `${AgenticProcess.type}-`;
  const id = typeIdStr.startsWith(prefix) ? typeIdStr.slice(prefix.length) : typeIdStr;

  if (op === 'delete') {
    if (trackers.delete(id)) {
      const now = Date.now();
      if (rebuildSnapshot(now)) notify();
    }
    return;
  }

  if (!data || typeof data !== 'object') return;
  const obj = data as {
    status?: string;
    worker_status?: string;
    session_id?: string | null;
    project_id?: string | null;
    ready_for_input_since?: number | null;
  };
  const view: StatusBearingProcess = {
    status: obj.status,
    worker_status: obj.worker_status,
    session_id: obj.session_id ?? null,
  };
  const ready = isReadyForInput(view);
  const newStatus = obj.status;
  const newWorkerStatus = obj.worker_status;
  const projectId = obj.project_id ?? null;
  const serverReadyAt = ready ? (obj.ready_for_input_since ?? null) : null;
  const now = Date.now();

  const prev = trackers.get(id);
  if (!prev) {
    trackers.set(id, {
      processId: id,
      projectId,
      status: newStatus,
      workerStatus: newWorkerStatus,
      ready,
      lastStatusChangedAt: now,
      readyAt: serverReadyAt,
    });
    if (ready && serverReadyAt !== null) ensureTimer();
    if (rebuildSnapshot(now)) notify();
    return;
  }

  let dirty = false;
  if (prev.status !== newStatus || prev.workerStatus !== newWorkerStatus) {
    prev.status = newStatus;
    prev.workerStatus = newWorkerStatus;
    prev.lastStatusChangedAt = now;
    dirty = true;
  }
  if (prev.projectId !== projectId) {
    prev.projectId = projectId;
    dirty = true;
  }
  if (prev.ready !== ready) {
    prev.ready = ready;
    dirty = true;
  }
  if (prev.readyAt !== serverReadyAt) {
    prev.readyAt = serverReadyAt;
    if (serverReadyAt !== null) ensureTimer();
    dirty = true;
  }
  if (dirty && rebuildSnapshot(now)) notify();
  else if (dirty) {
    // Status / project changed but pending set is unchanged — still notify so
    // tooltip subscribers (useLastStatusChange) re-render.
    for (const l of listeners) l();
  }
}

function attachOnce(): void {
  if (attached) return;
  attached = true;
  subscribeToEntityOps(
    AgenticProcess.type,
    (typeId, op, data) => handleDataOp(typeId.toString(), op, data as unknown),
  );
  // No op filter — pending-actions cares about all AgenticProcess ops
  // (create / update / delete). Module-scoped: never unsubscribe.
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
  const t = trackers.get(processId);
  return !!t && isCurrentlyPending(t, Date.now());
}

/** Mark the current ready transition as seen. Persisted to localStorage so a
 *  page refresh sees the same server `ready_for_input_since` and stays quiet.
 *  The next time the worker transitions out of and back into ready, the
 *  server stamps a fresh timestamp greater than the persisted ack, and the
 *  glow re-arms. */
export function acknowledgePending(processId: string | null | undefined): void {
  if (!processId) return;
  const t = trackers.get(processId);
  if (!t || t.readyAt === null) return;
  ackedReadyAt.set(processId, t.readyAt);
  persistAcks();
  const now = Date.now();
  if (rebuildSnapshot(now)) notify();
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

/** Returns the wall-time (ms) of the most recent observed status/worker_status
 *  change for ``processId``. Null when the process has never been observed. */
export function useLastStatusChange(processId: string | null | undefined): number | null {
  // Subscribe so tooltip re-renders on status updates.
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (!processId) return null;
  const t = trackers.get(processId);
  return t ? t.lastStatusChangedAt : null;
}

/** Format a millisecond timestamp as a short "ago" string. */
export function formatTimeAgo(ms: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
