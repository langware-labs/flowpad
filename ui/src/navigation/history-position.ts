/**
 * Where we are in the browser's session history, and therefore whether Back and
 * Forward are available. Pure — no DOM, no React, no I/O. Every rule lives in
 * `reduceHistoryPosition`, which is why this file is the whole unit-test surface
 * for history semantics.
 *
 * The position comes from react-router's own `window.history.state.idx`, which
 * `createBrowserHistory` seeds with a `replaceState` at creation and increments
 * on every push. We do NOT keep a shadow stack of visited entries: the previous
 * implementation did, drove it in parallel with `navigate(±1)`, and got both
 * predicates wrong (forward truncated its own stack on the first click; a
 * rehydrate left Back disabled and Forward enabled). The browser already has
 * the one true stack — read from it, never mirror it.
 *
 * `maxIdx` is the one thing the browser will NOT tell us: there is no API for
 * "how many entries are ahead of me". So we remember the highest index reached
 * in this tab and derive forward-availability from it. That is the entire
 * bookkeeping surface, and it is a single integer.
 */

export type HistoryAction = 'POP' | 'PUSH' | 'REPLACE';

export interface HistoryPosition {
  /** react-router's `window.history.state.idx`, or -1 when unavailable. */
  idx: number;
  /** Highest idx reachable going forward from here, in THIS tab's session. */
  maxIdx: number;
  canGoBack: boolean;
  canGoForward: boolean;
}

export const UNAVAILABLE: HistoryPosition = {
  idx: -1,
  maxIdx: -1,
  canGoBack: false,
  canGoForward: false,
};

/**
 * Fold a navigation into the position. The action matters as much as the index:
 *
 * - PUSH truncates the forward stack — ALWAYS, including a push made while
 *   sitting behind the head. That is the rule the old shadow stack inverted,
 *   and the reason Forward died after one click.
 * - REPLACE does not destroy forward entries, and react-router's `replace`
 *   leaves `idx` untouched, so the ceiling only ever rises. (`<Navigate replace>`
 *   appears several times in the router, so this fires in practice.)
 * - POP moves within the existing stack; the ceiling only rises, which is also
 *   what makes a cold boot correct: landing at idx 4 with no memory seeds the
 *   ceiling at 4 — Back available, Forward unknown and therefore disabled.
 *
 * A null idx means we are not on react-router's browser history at all (a memory
 * router, or a host that stripped history state). Fail CLOSED: a disabled button
 * is always better than one that navigates somewhere unexpected.
 */
export function reduceHistoryPosition(
  prev: Pick<HistoryPosition, 'maxIdx'>,
  next: { idx: number | null; action: HistoryAction },
): HistoryPosition {
  const { idx, action } = next;
  if (idx == null || !Number.isFinite(idx) || idx < 0) return UNAVAILABLE;

  const previousMax = Number.isFinite(prev.maxIdx) ? prev.maxIdx : -1;
  const maxIdx = action === 'PUSH' ? idx : Math.max(previousMax, idx);

  return {
    idx,
    maxIdx,
    canGoBack: idx > 0,
    canGoForward: idx < maxIdx,
  };
}
