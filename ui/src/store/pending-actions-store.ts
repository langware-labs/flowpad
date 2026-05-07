import { AgenticProcess, ConnectionManager, isReadyForInput, type StatusBearingProcess } from '@sdk';
import { useMemo, useSyncExternalStore } from 'react';

/**
 * Pending Actions store.
 *
 * "Pending action" semantics: a tab whose AgenticProcess is currently
 * ready-for-input AND whose most recent ready transition happened within the
 * last `PENDING_DURATION_MS` (300s). The first observation of a process that
 * is already ready is treated as a transition — the user has just opened a
 * surface where this tab already needs attention.
 *
 * Source of truth: ``isReadyForInput`` from the SDK, evaluated against the
 * raw entity payload on every WebSocket data op. Status / worker_status
 * timestamps are tracked separately for tooltip display.
 */

export interface PendingEntry {
  processId: string;
  projectId: string | null;
  /** Wall time (ms) of the most recent ready transition. */
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
  /** Wall time (ms) of the most recent ready transition. null if never observed ready. */
  lastReadyAt: number | null;
}

const PENDING_DURATION_MS = 300_000;
const TIMER_TICK_MS = 1_000;

const trackers = new Map<string, ProcessTracker>();
const listeners = new Set<() => void>();
let snapshot: ReadonlyArray<PendingEntry> = [];
let timer: ReturnType<typeof setInterval> | null = null;
let attached = false;

function isCurrentlyPending(t: ProcessTracker, now: number): boolean {
  return t.ready && t.lastReadyAt !== null && now - t.lastReadyAt < PENDING_DURATION_MS;
}

function rebuildSnapshot(now: number): boolean {
  const next: PendingEntry[] = [];
  for (const t of trackers.values()) {
    if (isCurrentlyPending(t, now)) {
      next.push({ processId: t.processId, projectId: t.projectId, readyAt: t.lastReadyAt as number });
    }
  }
  // Cheap shallow comparison: same length + same ids (order-insensitive)
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
    const anyReady = Array.from(trackers.values()).some((t) => t.ready && t.lastReadyAt !== null);
    const changed = rebuildSnapshot(now);
    if (changed) notify();
    if (!anyReady && timer) {
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
      // First observation: if currently ready, treat as a fresh transition so
      // tabs already awaiting input glow on app load / after navigation.
      lastReadyAt: ready ? now : null,
    });
    if (ready) ensureTimer();
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
  if (!prev.ready && ready) {
    // Fresh ready transition — restart the 300s window.
    prev.ready = true;
    prev.lastReadyAt = now;
    ensureTimer();
    dirty = true;
  } else if (prev.ready && !ready) {
    prev.ready = false;
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
  const t = trackers.get(processId);
  return !!t && isCurrentlyPending(t, Date.now());
}

/** Clear pending state for ``processId`` (e.g. user opened the tab). The
 *  status tracker is preserved so the tooltip still reads the latest
 *  change-age; only the glow is dismissed. The next fresh ready transition
 *  re-arms the glow. */
export function acknowledgePending(processId: string | null | undefined): void {
  if (!processId) return;
  const t = trackers.get(processId);
  if (!t || t.lastReadyAt === null) return;
  t.lastReadyAt = null;
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
