import { AgenticProcess, classifyExecutionMode, dataManager, ExecutionMode, isReadyForInput, isWorkerRunning, WorkerStatus, type StatusBearingProcess } from '@sdk';
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
  /** PTY (visible=true) vs headless CLI (visible=false). Routes ExecutionMode. */
  visible: boolean | undefined;
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
// Monotonic counter bumped on every notify() so consumers that re-derive
// from `trackers` (and not just `snapshot`) — i.e. useActiveProcesses,
// which surfaces burning-only entries that never enter `snapshot` —
// can subscribe via useSyncExternalStore and re-render reliably.
let activeTick = 0;
const getActiveTick = (): number => activeTick;

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
  activeTick++;
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

/**
 * Single ingestion point for AgenticProcess WS ops (create / update / delete).
 * Exported for unit tests so they can drive the real tracker pipeline with
 * synthetic ops instead of standing up the WS bus; production code reaches it
 * only via the `subscribeToEntityOps` wiring in `attachOnce`.
 */
export function handleDataOp(typeIdStr: string, op: string, data: unknown): void {
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
    visible?: boolean;
  };
  // WS ops are partial: a worker_status-only update would have
  // `ready_for_input_since: undefined` and wipe our tracker's readyAt
  // back to null. Merge with the cached entity so the tracker always
  // reflects the latest known truth across all fields.
  const cached = AgenticProcess.getByIdFromCache<AgenticProcess>(id) as
    | (AgenticProcess & {
        status?: string;
        worker_status?: string;
        session_id?: string | null;
        project_id?: string | null;
        ready_for_input_since?: number | null;
        visible?: boolean;
      })
    | null;
  const merged = {
    status: obj.status ?? cached?.status,
    worker_status: obj.worker_status ?? cached?.worker_status,
    session_id: obj.session_id ?? cached?.session_id ?? null,
    project_id: obj.project_id ?? cached?.project_id ?? null,
    ready_for_input_since: obj.ready_for_input_since ?? cached?.ready_for_input_since ?? null,
    visible: obj.visible ?? cached?.visible,
  };
  const view: StatusBearingProcess = {
    status: merged.status,
    worker_status: merged.worker_status,
    session_id: merged.session_id,
  };
  const ready = isReadyForInput(view);
  const newStatus = merged.status;
  const newWorkerStatus = merged.worker_status;
  const newVisible = merged.visible;
  const projectId = merged.project_id;
  const serverReadyAt = ready ? merged.ready_for_input_since : null;
  const now = Date.now();

  const prev = trackers.get(id);
  if (!prev) {
    trackers.set(id, {
      processId: id,
      projectId,
      status: newStatus,
      workerStatus: newWorkerStatus,
      visible: newVisible,
      ready,
      lastStatusChangedAt: now,
      readyAt: serverReadyAt,
    });
    if (ready && serverReadyAt !== null) ensureTimer();
    if (rebuildSnapshot(now)) notify();
    else {
      // First time seeing this tracker; the pending snapshot may not
      // have changed (process is burning but not yet ready-for-input),
      // but useActiveProcesses still needs to re-render to surface it.
      activeTick++;
      for (const l of listeners) l();
    }
    return;
  }

  let dirty = false;
  if (prev.status !== newStatus || prev.workerStatus !== newWorkerStatus) {
    prev.status = newStatus;
    prev.workerStatus = newWorkerStatus;
    prev.lastStatusChangedAt = now;
    dirty = true;
  }
  if (prev.visible !== newVisible) {
    // visible flip (interactive↔background) doesn't change pending/burning, but
    // it moves the row between execution-mode buckets — re-derive the list.
    prev.visible = newVisible;
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
    // tooltip subscribers (useLastStatusChange) and the active-processes
    // view (which derives burning-state from trackers, not snapshot)
    // re-render. Bump activeTick directly; skip the dev log since the
    // pending set didn't change.
    activeTick++;
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

  // Seed from anything already cached: route loaders hydrate AgenticProcess
  // entities before the chip mounts, so by the time we subscribe to WS
  // ops above, the next op may not arrive for minutes — and the chip
  // would be blind to currently-burning / currently-pending processes.
  // We feed each cached entity through handleDataOp as a synthetic
  // 'update' so the tracker map is populated immediately.
  seedFromCache();
}

function seedFromCache(): void {
  try {
    const dm = dataManager as unknown as {
      entities?: { values?: () => Iterable<{ entity?: AgenticProcess | null }> };
    };
    const refs = dm.entities?.values?.();
    if (!refs) return;
    for (const ref of refs) {
      const e = ref?.entity;
      if (!e || e.getType?.() !== AgenticProcess.type) continue;
      const id = (e as AgenticProcess & { id?: string }).id;
      if (!id) continue;
      handleDataOp(`${AgenticProcess.type}-${id}`, 'update', e as unknown);
    }
  } catch (err) {
    console.warn('[pending-actions] seedFromCache failed', err);
  }
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

/** Shared shape for a tracked worker surfaced to a React view. */
export interface ActiveProcessEntry {
  processId: string;
  projectId: string | null;
  workerStatus: string | undefined;
  lastStatusChangedAt: number;
  /** True while the worker is mid-turn. */
  burning: boolean;
  /** True while the process is currently in the pending (glow) set. */
  pending: boolean;
  /** Server-stamped readyAt if pending, else null. */
  readyAt: number | null;
}

function isBurningTracker(t: ProcessTracker): boolean {
  if (!t.workerStatus) return false;
  // workerStatus is the lowercase string form of the enum (see
  // ts_sdk/src/process/agentic-types.ts). isWorkerRunning takes the
  // enum type; the values match the strings sent on the wire.
  return isWorkerRunning(t.workerStatus as WorkerStatus);
}

/**
 * Worker-list view: EVERY live worker (`ProcessStatus ∈ {RUNNING, STARTING}`)
 * classified into an `ExecutionMode` — not just the burning∪pending subset.
 * Idle-but-running workers appear here too.
 *
 * `pending` / `burning` are still carried so the chip drives the per-row glow
 * and the pulse exactly as before; `mode` is the new grouping/filter axis.
 * `external` is never produced here — those rows come only from the `/workers`
 * backend snapshot.
 */
export interface WorkerListEntry extends ActiveProcessEntry {
  mode: ExecutionMode;
}

export function buildWorkerEntries(now: number): WorkerListEntry[] {
  const out: WorkerListEntry[] = [];
  for (const t of trackers.values()) {
    const mode = classifyExecutionMode({
      status: t.status,
      worker_status: t.workerStatus,
      visible: t.visible,
    });
    if (mode === null) continue; // not live → not listed
    const pending = isCurrentlyPending(t, now);
    const burning = isBurningTracker(t);
    out.push({
      processId: t.processId,
      projectId: t.projectId,
      workerStatus: t.workerStatus,
      lastStatusChangedAt: t.lastStatusChangedAt,
      burning,
      pending,
      readyAt: pending ? t.readyAt : null,
      mode,
    });
  }
  // Same ordering as the active view: pending first (newest readyAt), then
  // burning, then by last-status-change desc — stable React keys.
  out.sort((a, b) => {
    if (a.pending !== b.pending) return a.pending ? -1 : 1;
    if (a.pending && b.pending) return (b.readyAt ?? 0) - (a.readyAt ?? 0);
    return b.lastStatusChangedAt - a.lastStatusChangedAt;
  });
  return out;
}

/**
 * Subscribe to the worker list, filtered to the modes the current view mode
 * supports (pass `supportedExecutionModes(useIsAdvanced())`). Same dual
 * render-signal as `useActiveProcesses`.
 */
export function useWorkerList(
  supportedModes: readonly ExecutionMode[],
): ReadonlyArray<WorkerListEntry> {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const tick = useSyncExternalStore(subscribe, getActiveTick, getActiveTick);
  const key = supportedModes.join(',');
  return useMemo(() => {
    const allow = new Set(supportedModes);
    return buildWorkerEntries(Date.now()).filter((e) => allow.has(e.mode));
    // `key` captures the supported-mode set for memo invalidation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, key]);
}

/**
 * Per-mode counts over the supported set — drives the filter-toggle badges.
 * Modes with no live workers report 0 (every supported mode is a key).
 */
export function useWorkerCountsByMode(
  supportedModes: readonly ExecutionMode[],
): Record<ExecutionMode, number> {
  const list = useWorkerList(supportedModes);
  const key = supportedModes.join(',');
  return useMemo(() => {
    const counts = {} as Record<ExecutionMode, number>;
    for (const m of supportedModes) counts[m] = 0;
    for (const e of list) counts[e.mode] = (counts[e.mode] ?? 0) + 1;
    return counts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, key]);
}

/**
 * Test-only: clear all tracker state (the module `trackers` map + the pending
 * snapshot) so each unit test starts from an empty store. Not used in
 * production — the store is module-scoped and never reset at runtime.
 */
export function __resetTrackersForTest(): void {
  trackers.clear();
  snapshot = [];
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
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
