import { useCallback, useSyncExternalStore } from 'react';
import { useRevalidator } from 'react-router';
import { useDockNavigation } from './useDockNavigation';
import { getHistoryPosition, subscribeHistoryPosition } from './history-position-store';

/**
 * The nav bar's read adapter over history. It owns NOTHING:
 *
 *   - the predicates come from `history-position-store` (derived from the
 *     router's own `idx`, never a shadow stack),
 *   - the actions go through `NavigationActions`, which stays the single writer
 *     of navigation intent,
 *   - reload goes through the router's revalidator.
 *
 * `reload` is a SOFT reload: it re-runs the route loaders at the same URL. That
 * is the data-freshness action. A hard `window.location.reload()` is the
 * broken-runtime action — it tears down every PTY WebSocket, drops live process
 * attachment and the entity cache, and re-pays the cold bootstrap, which is far
 * too destructive for a button people click reflexively. `hardReload` stays
 * available for the modifier-click gesture, mirroring a browser's own.
 */
export interface HistoryNav {
  canGoBack: boolean;
  canGoForward: boolean;
  goBack: () => void;
  goForward: () => void;
  /** Re-run the loaders at the current URL. */
  reload: () => void;
  /** Full document reload — only for a runtime that is actually broken. */
  hardReload: () => void;
  reloading: boolean;
}

export function useHistoryNav(): HistoryNav {
  const { navigation } = useDockNavigation();
  const revalidator = useRevalidator();
  const position = useSyncExternalStore(subscribeHistoryPosition, getHistoryPosition, getHistoryPosition);

  const goBack = useCallback(() => navigation.goBack(), [navigation]);
  const goForward = useCallback(() => navigation.goForward(), [navigation]);
  const reload = useCallback(() => void revalidator.revalidate(), [revalidator]);
  const hardReload = useCallback(() => window.location.reload(), []);

  return {
    canGoBack: position.canGoBack,
    canGoForward: position.canGoForward,
    goBack,
    goForward,
    reload,
    hardReload,
    reloading: revalidator.state === 'loading',
  };
}
