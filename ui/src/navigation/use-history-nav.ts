import { useCallback, useSyncExternalStore } from 'react';
import { useDockNavigation } from './useDockNavigation';
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

export function useHistoryNav(): HistoryNav {
  const { navigation } = useDockNavigation();
  const position = useSyncExternalStore(subscribeHistoryPosition, getHistoryPosition, getHistoryPosition);

  const goBack = useCallback(() => navigation.goBack(), [navigation]);
  const goForward = useCallback(() => navigation.goForward(), [navigation]);
  const reload = useCallback(() => window.location.reload(), []);

  return {
    canGoBack: position.canGoBack,
    canGoForward: position.canGoForward,
    goBack,
    goForward,
    reload,
  };
}
