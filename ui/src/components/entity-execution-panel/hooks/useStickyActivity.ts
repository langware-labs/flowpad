import { useEffect, useRef, useState } from 'react';

import type { CurrentActivity } from '../current-activity';

/**
 * Shortest time an operation stays on the activity line before it can be
 * replaced. A `Read` or an `Edit` can start and finish between two frames, so
 * without a floor the line either flickers illegibly or never paints the
 * operation at all.
 */
export const MIN_ACTIVITY_MS = 500;

/**
 * Hold each activity on screen for at least {@link MIN_ACTIVITY_MS}, then jump
 * straight to the NEWEST one available.
 *
 * Deliberately not a queue. When several operations land inside one window the
 * intermediate ones are skipped rather than replayed in sequence — a queue
 * would put the line further and further behind the agent, showing a file it
 * edited seconds ago while it is already three tools further on. The line's job
 * is "what is happening now", so falling behind is worse than dropping a frame;
 * the event chip beside it keeps the full count, and the turn's rows keep the
 * full list.
 *
 * Passing `null` (nothing running) is held to the same floor, so the last
 * operation of a turn cannot be blanked the instant it completes.
 */
export function useStickyActivity(
  activity: CurrentActivity | null,
  /**
   * Identity of the turn being reported (its start time). A held value is
   * scoped to ONE turn: without this, an operation still inside its minimum
   * window when a turn ends would carry over and be shown as the next turn's
   * activity — reintroducing exactly the stale-readout bug the turn scoping in
   * `describeCurrentActivity` exists to prevent. A turn change drops the held
   * value immediately; the floor never outlives its turn.
   */
  resetKey: number | null,
  minMs: number = MIN_ACTIVITY_MS,
): CurrentActivity | null {
  const [shown, setShown] = useState<CurrentActivity | null>(activity);
  // The newest value, read at TIMER-FIRE time rather than captured at schedule
  // time — that is what makes the swap land on the newest operation instead of
  // whichever one happened to be pending when the timer was set.
  const latest = useRef(activity);
  // Seeded when the hook mounts with an operation already in hand — a pane
  // remounting mid-turn. Left at 0 (i.e. "long ago") when it mounts idle, so
  // the turn's first operation appears immediately rather than serving a
  // window it never occupied.
  const shownAt = useRef(activity ? Date.now() : 0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const turn = useRef(resetKey);

  latest.current = activity;

  useEffect(() => {
    if (turn.current !== resetKey) {
      turn.current = resetKey;
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      // Zero (not "now") so the new turn's first operation appears at once
      // instead of serving out the previous turn's remaining window.
      shownAt.current = 0;
      setShown(activity);
      return;
    }

    const current = shown?.key ?? null;
    const next = activity?.key ?? null;

    // Same operation, better information. The stream reports one operation more
    // than once — a PreToolUse hook observation and the worker's own live frame
    // are two `ProcessEntry` views of a single `transcript_entry`, and the
    // earlier one can reach us before the path/command is known. That is a
    // REFINEMENT, not a new operation: rate-limiting it (as comparing `key`
    // alone does) strands the line on "Editing" with no filename until some
    // unrelated operation displaces it. Apply it at once, and leave `shownAt`
    // alone so the operation as a whole still serves its full window.
    if (current === next) {
      if (!sameContent(shown, activity)) setShown(activity);
      return;
    }

    const waited = Date.now() - shownAt.current;
    if (waited >= minMs) {
      shownAt.current = Date.now();
      setShown(latest.current);
      return;
    }

    if (timer.current !== null) return; // a swap is already scheduled
    timer.current = setTimeout(() => {
      timer.current = null;
      shownAt.current = Date.now();
      setShown(latest.current);
    }, minMs - waited);
  }, [activity, shown, minMs, resetKey]);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  return shown;
}

/** Do these two render identically? (Both null counts as identical.) */
function sameContent(a: CurrentActivity | null, b: CurrentActivity | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.label === b.label && a.detail === b.detail && a.title === b.title && a.icon === b.icon;
}
