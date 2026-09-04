/**
 * The frontend mirror of the backend's `ActivityProgressMonitor`.
 *
 * It is a MIRROR, never a second source of truth: it is fed by `progress_report` WS
 * snapshots and replayed from `GET /api/v1/activity`, and nothing in the UI writes an
 * activity state locally. Starting work does not mean optimistically setting `running` —
 * the backend is the single writer, the same rule the URL-first navigation loaders follow.
 *
 * Three rules earn their keep here:
 *
 * * **Drop by `seq`.** Every snapshot is complete state, so ordering is the only thing a
 *   consumer must get right: ignore anything not GREATER than what is held for that root.
 *   This replaces the bespoke superseded-phase guard the indexer service needed.
 * * **Hold a terminal root briefly.** The backend evicts the moment it records a terminal,
 *   because it tracks live work. The receipt still has to be readable, so the grace period
 *   lives here — frontend-only, and deliberately not a backend delay.
 * * **Key children by `path`.** An index key would reshuffle React rows the moment a child
 *   appears mid-run.
 *
 * Shaped after `pending-actions-store`: a module-level map, a listener set, and
 * `useSyncExternalStore` hooks, with one exported ingestion point so a test can drive the
 * real pipeline with synthetic snapshots instead of standing up a WS bus.
 */

import { connectionManager } from '@sdk/websocket';
import { isTerminal, listActivities, type ActivityProgressSpec } from '@sdk/activity';
import { useSyncExternalStore } from 'react';

/** The FlowData element activity snapshots ride, shared with older progress payloads. */
const PROGRESS_ELEMENT = 'progress_report';
/** Mirrors `ACTIVITY_KIND` in `flow_sdk/activity/emit.py` — which payload this envelope is. */
const ACTIVITY_KIND = 'activity';

/**
 * How long a finished root stays on screen after its terminal snapshot. Long enough to
 * read "indexed 5,000 · 3 errors", short enough that the chip does not lie about what is
 * running. It is a display grace period, not a wait budget on anything.
 */
export const RECEIPT_LINGER_MS = 2000;

const specs = new Map<string, ActivityProgressSpec>();
const listeners = new Set<() => void>();
const evictionTimers = new Map<string, ReturnType<typeof setTimeout>>();
let snapshot: ReadonlyArray<ActivityProgressSpec> = [];
let attached = false;

function key(spec: Pick<ActivityProgressSpec, 'scope' | 'path'>): string {
  return `${spec.scope ?? ''}::${spec.path}`;
}

/** Most-recently-updated first, with the timestamp parsed once per ingest rather than
 *  `O(N log N)` times inside the comparator on every frame. */
const sortKeys = new Map<string, number>();

function rebuild(): void {
  snapshot = Array.from(specs.entries())
    .sort(([ka], [kb]) => (sortKeys.get(kb) ?? 0) - (sortKeys.get(ka) ?? 0))
    .map(([, spec]) => spec);
}

function notify(): void {
  rebuild();
  for (const l of listeners) l();
}

/**
 * Subscribe to store changes. Returns an unsubscribe callable.
 *
 * Exported for non-React consumers (and for tests): the hooks below are one caller of
 * this, not the only possible one.
 */
export function subscribeToActivities(listener: () => void): () => void {
  attachOnce();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const subscribe = subscribeToActivities;

const getSnapshot = (): ReadonlyArray<ActivityProgressSpec> => snapshot;

/**
 * Single ingestion point for activity snapshots.
 *
 * Exported for tests so they drive the real pipeline with synthetic snapshots; production
 * reaches it only through the WS wiring in `attachOnce`.
 */
export function handleActivitySnapshot(spec: ActivityProgressSpec): void {
  const k = key(spec);
  const held = specs.get(k);

  // Out-of-order or duplicate. A fresh activity at a recycled address restarts at seq 0,
  // which is why this compares against the held snapshot rather than a high-water mark.
  if (held && spec.seq <= held.seq && held.activity_id === spec.activity_id) return;

  const timer = evictionTimers.get(k);
  if (timer != null) {
    clearTimeout(timer);
    evictionTimers.delete(k);
  }

  specs.set(k, spec);
  sortKeys.set(k, Date.parse(spec.updated_at ?? spec.started_at ?? '') || 0);

  if (isTerminal(spec)) {
    evictionTimers.set(
      k,
      setTimeout(() => {
        evictionTimers.delete(k);
        const current = specs.get(k);
        // Only drop what is still the finished one: a new activity may have claimed the
        // address while the receipt was on screen.
        if (current && current.activity_id === spec.activity_id) {
          specs.delete(k);
          sortKeys.delete(k);
          notify();
        }
      }, RECEIPT_LINGER_MS),
    );
  }

  notify();
}

function attachOnce(): void {
  if (attached) return;
  attached = true;
  connectionManager.on('on_flow_data', (_typeId: unknown, flowData: Record<string, unknown>) => {
    if (flowData?.element_type !== PROGRESS_ELEMENT) return;
    const attrs = flowData?.attributes as (ActivityProgressSpec & { kind?: string }) | undefined;
    // The element is shared with the indexer table and the process status report; the
    // kind discriminator is what says this envelope is ours.
    if (!attrs || attrs.kind !== ACTIVITY_KIND) return;
    handleActivitySnapshot(attrs);
  });
  // Replay on every connect, not just the first. A socket gap means missed ticks, and a
  // snapshot is complete state — so one GET is the entire reconnect story. Without this a
  // dropped connection leaves the chip frozen on whatever it last heard, which looks
  // exactly like a stalled job.
  connectionManager.on('on_open', () => {
    void replay();
  });
  void replay();
}

/** Seed from the backend. Covers first paint and any reconnect gap. */
export async function replay(): Promise<void> {
  const rows = await listActivities(null, true);
  for (const row of rows) handleActivitySnapshot(row);
}

/** Test seam: forget everything, including pending receipt timers. */
export function __resetActivityStoreForTest(): void {
  for (const timer of evictionTimers.values()) clearTimeout(timer);
  evictionTimers.clear();
  specs.clear();
  sortKeys.clear();
  snapshot = [];
  attached = false;
}

/**
 * Every live root, most recently updated first — the plain read.
 *
 * Exported alongside the hooks so a test (and any non-React caller) can read the store
 * without rendering, the way `pending-actions-store` exposes `buildWorkerEntries`.
 */
export function getActivities(): ReadonlyArray<ActivityProgressSpec> {
  return snapshot;
}

/** One activity by address, without rendering. */
export function getActivity(path: string, scope?: string | null): ActivityProgressSpec | null {
  return specs.get(`${scope ?? ''}::${path}`) ?? null;
}

/** Every live root, most recently updated first. */
export function useActivities(): ReadonlyArray<ActivityProgressSpec> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** One activity by address, or `null` when nothing is live there. */
export function useActivitySpec(path: string, scope?: string | null): ActivityProgressSpec | null {
  // Subscribe for re-renders, then read the map directly — a linear scan of the snapshot
  // is not needed when the store is already keyed by address.
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return getActivity(path, scope);
}

/** How many activities are live — for a caller that needs the count and not the rows. */
export function useActivityCount(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot).length;
}
