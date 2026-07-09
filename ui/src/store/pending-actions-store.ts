import { AgenticProcess, classifyExecutionMode, dataManager, ExecutionMode, isBusy, isReadyForInput } from '@sdk';
import { subscribeToEntityOps } from '@sdk/react/hooks';
import { useCallback, useMemo, useSyncExternalStore } from 'react';

/**
 * Pending Actions store.
 *
 * "Pending action" (glow) semantics: an AgenticProcess that has just
 * *transitioned into* the ready-for-input state (RUNNING and not busy — a turn
 * finished; the worker is now awaiting the user, "something is waiting for you
 * now") within the last `PENDING_DURATION_MS` (300s) and that the user has not
 * yet acknowledged (clicked) this session. Keying on ``isReadyForInput`` (the
 * ``status === RUNNING && !busy`` predicate) is the client-side replacement for
 * the removed backend PENDING_USER projection.
 *
 * The glow is **transition-driven and client-stamped**: it arms only on an
 * observed live status change into a glow status, and `readyAt` is the client
 * wall-time of that transition. A process already sitting in a glow status the
 * first time the store sees it (cache seed / page reload) does NOT glow — only
 * a fresh transition does. There is no server timestamp; the glow is a
 * live-session attention signal, not restored across refresh.
 *
 * Ack state is in-memory only (a refresh starts clean anyway), so opening a
 * process clears its glow for the rest of the session.
 */

export interface PendingEntry {
  processId: string;
  projectId: string | null;
  /** Client wall time (ms) when the worker transitioned into a glow status. */
  readyAt: number;
}

export interface ProcessTracker {
  processId: string;
  projectId: string | null;
  status: string | undefined;
  workerStatus: string | undefined;
  /** Turn-in-flight boolean serialized alongside ``status``. The single value the
   *  burning/glow predicates gate on (via ``isBusy`` / ``isReadyForInput``). */
  busy: boolean | undefined;
  /** PTY (visible=true) vs headless CLI (visible=false). Routes ExecutionMode. */
  visible: boolean | undefined;
  /** True while currently ready-for-input (RUNNING and not busy). */
  glowing: boolean;
  /** Wall time (ms) of the most recent observed status / worker_status change. */
  lastStatusChangedAt: number;
  /** Client epoch ms of the most recent observed transition INTO a glow status.
   *  Null until such a transition is seen — including while `glowing` is already
   *  true on first observation (cache seed / reload never arms the glow). */
  readyAt: number | null;
}

const PENDING_DURATION_MS = 300_000;
const TIMER_TICK_MS = 1_000;

/** True when the process is live and awaiting the user. The glow arms on the
 *  transition INTO this state (see the arm/disarm logic in `handleDataOp`); a
 *  process already ready on first observation never arms. Delegates to the SDK's
 *  `isReadyForInput` so "awaiting the user" is defined in one place. */
function isGlowStatus(status: string | undefined, busy: boolean | undefined): boolean {
  return isReadyForInput({ status, busy });
}

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

// Session-scoped: `{ processId → ackedReadyAt }`. Not persisted — a refresh
// starts clean because the glow is a live-session transition signal that does
// not restore across reloads anyway.
const ackedReadyAt: Map<string, number> = new Map();

function isCurrentlyPending(t: ProcessTracker, now: number): boolean {
  if (!t.glowing || t.readyAt === null) return false;
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
    const anyReady = Array.from(trackers.values()).some((t) => t.glowing && t.readyAt !== null);
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
    busy?: boolean;
    project_id?: string | null;
    visible?: boolean;
  };
  // WS ops are partial: merge with the cached entity so the tracker always
  // reflects the latest known truth across all fields (a worker_status-only
  // update must not wipe the other fields).
  const cached = AgenticProcess.getByIdFromCache<AgenticProcess>(id) as
    | (AgenticProcess & {
        status?: string;
        worker_status?: string;
        busy?: boolean;
        project_id?: string | null;
        visible?: boolean;
      })
    | null;
  const merged = {
    status: obj.status ?? cached?.status,
    worker_status: obj.worker_status ?? cached?.worker_status,
    // ``busy`` is a boolean, so ``??`` (not ``||``) preserves an explicit false.
    busy: obj.busy ?? cached?.busy,
    project_id: obj.project_id ?? cached?.project_id ?? null,
    visible: obj.visible ?? cached?.visible,
  };
  const glowing = isGlowStatus(merged.status, merged.busy);
  const newStatus = merged.status;
  const newWorkerStatus = merged.worker_status;
  const newBusy = merged.busy;
  const newVisible = merged.visible;
  const projectId = merged.project_id;
  const now = Date.now();

  const prev = trackers.get(id);
  if (!prev) {
    // First observation (create / cache seed): never arm the glow, even if the
    // process is already in a glow status. The glow is transition-driven — only
    // a subsequent live change INTO a glow status stamps `readyAt`.
    trackers.set(id, {
      processId: id,
      projectId,
      status: newStatus,
      workerStatus: newWorkerStatus,
      busy: newBusy,
      visible: newVisible,
      glowing,
      lastStatusChangedAt: now,
      readyAt: null,
    });
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
  if (
    prev.status !== newStatus ||
    prev.workerStatus !== newWorkerStatus ||
    prev.busy !== newBusy
  ) {
    prev.status = newStatus;
    prev.workerStatus = newWorkerStatus;
    // ``busy`` flips drive the per-row burning indicator (isBurningTracker) and,
    // combined with status, the glow arm/disarm below.
    prev.busy = newBusy;
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
  if (prev.glowing !== glowing) {
    prev.glowing = glowing;
    // Arm on a transition INTO a glow status (client-stamp the moment); clear on
    // the way out.
    if (glowing) {
      prev.readyAt = now;
      ensureTimer();
    } else {
      prev.readyAt = null;
    }
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

/** Mark the current glow transition as seen for the rest of this session, so
 *  clicking the process clears its glow. In-memory only — a page refresh starts
 *  clean since the glow does not restore across reloads. The next live
 *  transition into a glow status stamps a fresh `readyAt` and re-arms. */
export function acknowledgePending(processId: string | null | undefined): void {
  if (!processId) return;
  const t = trackers.get(processId);
  if (!t || t.readyAt === null) return;
  ackedReadyAt.set(processId, t.readyAt);
  const now = Date.now();
  if (rebuildSnapshot(now)) notify();
}

export function usePendingActions(): ReadonlyArray<PendingEntry> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
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

/** True while ``processId``'s worker is mid-turn (actively doing work). Live —
 *  re-renders on every status change via the `activeTick` signal (status flips
 *  that don't change the pending snapshot still bump it). Drives the per-row
 *  "working" indicator in the Chats navigator. */
export function useIsBurning(processId: string | null | undefined): boolean {
  // Snapshot THIS process's burning boolean. useSyncExternalStore bails out of
  // re-render when the value is unchanged (Object.is) — so a row re-renders only
  // when its own worker flips burning, not on every store tick (avoids O(N)
  // re-renders across the chats list when any one worker changes status).
  const getBurning = useCallback((): boolean => {
    if (!processId) return false;
    const t = trackers.get(processId);
    return t ? isBurningTracker(t) : false;
  }, [processId]);
  return useSyncExternalStore(subscribe, getBurning, getBurning);
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
  /** Client transition-stamped readyAt if pending, else null. */
  readyAt: number | null;
}

function isBurningTracker(t: ProcessTracker): boolean {
  // "Burning" = a turn is in flight. Uses the SDK's `isBusy` (the single logical
  // ``busy`` wire status) so the per-row "working" indicator matches the
  // composer/toggle gate exactly.
  return isBusy(t);
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
