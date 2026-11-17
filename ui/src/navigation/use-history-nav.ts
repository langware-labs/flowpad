import { useCallback, useRef, useSyncExternalStore } from 'react';
import { useNavigationActions } from './useNavigationActions';
import { getHistoryPosition, subscribeHistoryPosition } from './history-position-store';

/**
 * The nav bar's read adapter over history. It owns NOTHING:
 *
 *   - the predicates come from `history-position-store` (derived from the
 *     router's own `idx`, never a shadow stack),
 *   - the actions go through `NavigationActions`, which stays the single writer
 *     of navigation intent,
 *   - reload is `window.location.reload()`, in the browser and in Electron
 *     alike.
 *
 * That last one was once a router revalidation, on the theory that re-running
 * the loaders was a cheaper way to freshen data. It is not: they resolve entity
 * identity and read through the SDK's caches, so a click fetched nothing and
 * changed nothing on screen.
 */
export interface HistoryNav {
  canGoBack: boolean;
  canGoForward: boolean;
  goBack: () => void;
  goForward: () => void;
  /** Full window reload, exactly as the browser's own reload button. */
  reload: () => void;
}

const readCanGoBack = () => getHistoryPosition().canGoBack;
const readCanGoForward = () => getHistoryPosition().canGoForward;

export function useHistoryNav(): HistoryNav {
  const navigation = useNavigationActions();
  // The two answers, not the position: every push moves `idx`, and re-rendering
  // the nav bar for a Back button that looks the same was part of each tab switch.
  const canGoBack = useSyncExternalStore(subscribeHistoryPosition, readCanGoBack, readCanGoBack);
  const canGoForward = useSyncExternalStore(subscribeHistoryPosition, readCanGoForward, readCanGoForward);

  // Stable across navigations (the actions object is rebuilt on each), so the
  // buttons holding them can stay memoized.
  const navigationRef = useRef(navigation);
  navigationRef.current = navigation;
  const goBack = useCallback(() => navigationRef.current.goBack(), []);
  const goForward = useCallback(() => navigationRef.current.goForward(), []);
  const reload = useCallback(() => window.location.reload(), []);

  return {
    canGoBack,
    canGoForward,
    goBack,
    goForward,
    reload,
  };
}
