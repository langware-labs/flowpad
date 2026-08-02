import { useSyncExternalStore } from 'react';

/**
 * Whether the user has minimized the environment banner — "until next restart".
 *
 * Held in `sessionStorage`, which is exactly that lifetime and nothing more: it
 * survives a reload and in-app navigation (dismissing a banner that came back
 * on every route change would be worse than not having a close button), and it
 * is gone when the app is relaunched — a fresh Electron window and a new tab
 * both start empty. `localStorage` would outlive the restart the user was
 * promised; module state alone would not survive a reload.
 *
 * Deliberately NOT a user preference: the banner says what runtime you are on,
 * which is a safety signal in a cloud sandbox or an agent's box. Making the
 * dismissal permanent would let someone silence that once and forget.
 *
 * Two surfaces read this (the banner and the rail's Home icon) and they must
 * flip together, so it is a subscribable store rather than component state.
 */
const KEY = 'flowpad.environment-banner.minimized';

const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return window.sessionStorage.getItem(KEY) === '1';
  } catch {
    // Storage can throw (private mode, disabled cookies). A banner that shows
    // is the safe failure: it never hides what runtime you are on.
    return false;
  }
}

// Read once, then keep in memory. `useSyncExternalStore` calls the snapshot on
// every render of every subscriber plus a tearing check, and one subscriber is
// the rail — which re-renders on route, dock and badge changes. This value
// changes at most once per session, so touching storage each time is pure waste.
// A stable primitive also can't trip React's "getSnapshot should be cached" path.
let cached = read();

function set(minimized: boolean): void {
  try {
    if (minimized) window.sessionStorage.setItem(KEY, '1');
    else window.sessionStorage.removeItem(KEY);
  } catch {
    // Non-fatal: the in-memory value below still flips for this session.
  }
  cached = minimized;
  listeners.forEach((l) => l());
}

// No `storage` listener: that event fires only for OTHER tabs, and sessionStorage
// is per-tab and never shared with them. There is nothing to sync with.
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Minimize the banner for the rest of this app session. */
export function minimizeBanner(): void {
  set(true);
}

/** Restore it (used by tests; there is no UI affordance — a restart brings it back). */
export function restoreBanner(): void {
  set(false);
}

export function useBannerMinimized(): boolean {
  // Server snapshot is `false` for the same reason as the catch above.
  return useSyncExternalStore(subscribe, () => cached, () => false);
}
