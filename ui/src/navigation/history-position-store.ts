import { toplog } from '@sdk';
import {
  reduceHistoryPosition,
  UNAVAILABLE,
  type HistoryAction,
  type HistoryPosition,
} from './history-position';

/**
 * THE owner of "can I go back / forward". One module-level store, framework
 * free, so `main.tsx` can read it before React mounts and `NavigationActions`
 * can read it without a hook.
 *
 * The event source is the data router, not `popstate` and not `useLocation`:
 *
 *   - `popstate` fires for back/forward but NOT for pushes, so a pushed
 *     navigation would never update the ceiling.
 *   - `useLocation` sees everything the router does but reports no
 *     `historyAction`, and PUSH vs REPLACE vs POP is exactly what the reducer
 *     needs to distinguish.
 *   - `router.subscribe` gives both, and it fires for pops the app did NOT
 *     originate — browser chrome buttons, the macOS swipe, and the Electron
 *     X1/X2 mouse buttons all reach react-router's own popstate handler. That
 *     is why those sources stay correct here without any coupling to them.
 *
 * Ordering is safe: react-router commits `history.push/replace` before it
 * notifies subscribers, so `window.history.state.idx` is already the new value
 * when we read it.
 */

const MAX_IDX_KEY = 'flowpad.history.maxIdx';
/** The zustand store this replaced persisted a shadow stack here. Every existing
 *  install still carries that key; drop it once so it stops confusing anyone
 *  reading storage. */
const LEGACY_HISTORY_KEY = 'navigation-history';

let position: HistoryPosition = UNAVAILABLE;
const listeners = new Set<() => void>();

function readStoredMaxIdx(): number {
  try {
    const raw = sessionStorage.getItem(MAX_IDX_KEY);
    if (raw == null) return -1;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : -1;
  } catch {
    // Private mode / a host with storage disabled. Not knowing the ceiling only
    // costs a disabled Forward button.
    return -1;
  }
}

function writeStoredMaxIdx(maxIdx: number): void {
  try {
    sessionStorage.setItem(MAX_IDX_KEY, String(maxIdx));
  } catch {
    /* see readStoredMaxIdx */
  }
}

function dropLegacyKey(): void {
  try {
    localStorage.removeItem(LEGACY_HISTORY_KEY);
  } catch {
    /* nothing to clean up if storage is unavailable */
  }
}

function readIdx(win: Window): number | null {
  const state = win.history?.state as { idx?: unknown } | null | undefined;
  const idx = state?.idx;
  return typeof idx === 'number' ? idx : null;
}

export function getHistoryPosition(): HistoryPosition {
  return position;
}

export function subscribeHistoryPosition(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/**
 * Recompute from live history state. `win` is injectable so the unit tests can
 * drive real transitions without a browser — jsdom's session history is an
 * approximation that notably does not reproduce forward-stack truncation, so
 * testing through it would assert the wrong thing.
 *
 * `maxIdx` is seeded from sessionStorage: it is per-tab and must survive F5,
 * which is exactly sessionStorage's lifetime. Combined with `idx` living in
 * history state (which the browser persists per entry), Forward now survives a
 * reload instead of being falsely enabled by a stale stack.
 */
export function syncHistoryPosition(action: HistoryAction, win: Window = window): void {
  const idx = readIdx(win);
  const prevMax = position === UNAVAILABLE ? readStoredMaxIdx() : position.maxIdx;
  const next = reduceHistoryPosition({ maxIdx: prevMax }, { idx, action });

  // idx and maxIdx are the whole state; both predicates are pure functions of
  // them, so comparing those two answers the question.
  const changed = next.idx !== position.idx || next.maxIdx !== position.maxIdx;

  position = next;
  // The router notifies on every state update — revalidations and fetcher
  // settles included — and most of those land on the same entry we are already
  // on. Only a real move is worth a storage write, a trace line, or waking the
  // subscribers.
  if (!changed) return;

  if (next.maxIdx >= 0) writeStoredMaxIdx(next.maxIdx);
  toplog.log('navigation', 'history-position', {
    action,
    idx: next.idx,
    maxIdx: next.maxIdx,
    canGoBack: next.canGoBack,
    canGoForward: next.canGoForward,
    url: win.location?.pathname,
  });
  listeners.forEach((fn) => fn());
}

/**
 * Wire the data router as the sole event source. Call once, at module scope in
 * `router.tsx`, right after the router is created — by then
 * `createBrowserHistory` has already stamped its initial `idx`.
 *
 * Only SETTLED navigations are folded in. The router notifies subscribers
 * several times per navigation, and `historyAction` does not become the new
 * action until the navigation completes — so mid-flight the action is still the
 * PREVIOUS one while `window.history.state.idx` has already moved. Reading that
 * pair would report a back-navigation as a push, and a push resets the forward
 * ceiling: Forward would go dead the instant you used Back. Waiting for `idle`
 * means the two halves are always read from the same navigation.
 */
export function bindHistoryPosition(router: {
  subscribe(
    fn: (state: { historyAction: HistoryAction; navigation?: { state?: string } }) => void,
  ): () => void;
}): () => void {
  dropLegacyKey();
  syncHistoryPosition('POP'); // seed from the entry we booted on
  return router.subscribe((state) => {
    if (state.navigation?.state && state.navigation.state !== 'idle') return;
    syncHistoryPosition(state.historyAction);
  });
}

export function resetHistoryPositionForTests(): void {
  position = UNAVAILABLE;
  listeners.clear();
}
