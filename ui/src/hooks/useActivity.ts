/**
 * Reading one activity for a component.
 *
 * The reason this is a hook and not a selector is `elapsedMs`: it must tick on its OWN
 * interval rather than on activity snapshots. An activity that has gone quiet stops
 * producing snapshots, and that is precisely when a person is staring at the row — an
 * elapsed time frozen at the last tick makes a slow job look like a hung one, and a hung
 * one look like nothing at all.
 *
 * Deriving last-tick age here also means the UI can grey a stalled row with no backend
 * involvement and no timeout invented anywhere.
 */

import { fraction, isTerminal, type ActivityProgressSpec } from '@sdk/activity';
import { useActivitySpec } from '@src/store/activity-store';
import { useSyncExternalStore } from 'react';

/** One second: the resolution an elapsed readout is displayed at anyway. */
const CLOCK_MS = 1000;

export interface ActivityView {
  spec: ActivityProgressSpec | null;
  /** Whether the row is still live, or is a receipt lingering after its terminal. */
  live: boolean;
  /** Since `started_at`, ticking independently of snapshots. `0` when never started. */
  elapsedMs: number;
  /** Since the last snapshot — how a stalled row is told from a slow one. */
  sinceLastTickMs: number;
  /** `null` when genuinely unknown; render a count, never a fabricated 0%. */
  fraction: number | null;
}

/**
 * ONE ticking clock for the whole app, ref-counted by its subscribers.
 *
 * A timer per row means N timers and N independent state updates every second, so React
 * commits N times a second to move N labels — and every row re-renders on its neighbours'
 * schedule. Sharing the source means one interval and one commit no matter how many rows
 * are on screen, and no timer at all while none are.
 */
const clockListeners = new Set<() => void>();
let clockNow = Date.now();
let clockTimer: ReturnType<typeof setInterval> | null = null;

function subscribeToClock(listener: () => void): () => void {
  clockListeners.add(listener);
  if (clockTimer === null) {
    // Resync on wake. The cached value is only advanced while the timer runs, so after an
    // idle stretch — no rows on screen — it still holds whenever the clock last stopped,
    // and the first row to mount would read its elapsed against that stale instant.
    clockNow = Date.now();
    clockTimer = setInterval(() => {
      clockNow = Date.now();
      for (const l of clockListeners) l();
    }, CLOCK_MS);
  }
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0 && clockTimer !== null) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}

const getClock = (): number => clockNow;

/** The shared clock. Subscribing keeps it running; the last unsubscriber stops it. */
export function useClock(): number {
  return useSyncExternalStore(subscribeToClock, getClock, getClock);
}

/**
 * Elapsed for one already-held spec.
 *
 * A list renders rows in a `.map`, where a hook cannot be called — so a row computes its
 * own elapsed rather than having the parent thread it down. A finished activity's elapsed
 * is its DURATION and stops moving; a live one keeps counting even while no snapshot
 * arrives, which is the whole point.
 */
export function useElapsedMs(spec: ActivityProgressSpec | null): number {
  const now = useClock();
  if (!spec?.started_at) return 0;
  const end = spec.finished_at ? Date.parse(spec.finished_at) : now;
  return Math.max(end - Date.parse(spec.started_at), 0);
}

export function useActivity(path: string, scope?: string | null): ActivityView {
  const spec = useActivitySpec(path, scope);
  const now = useClock();
  const elapsedMs = useElapsedMs(spec);

  if (!spec) {
    return { spec: null, live: false, elapsedMs: 0, sinceLastTickMs: 0, fraction: null };
  }
  const updated = spec.updated_at ? Date.parse(spec.updated_at) : null;
  return {
    spec,
    live: !isTerminal(spec),
    elapsedMs,
    sinceLastTickMs: updated ? Math.max(now - updated, 0) : 0,
    fraction: fraction(spec),
  };
}
