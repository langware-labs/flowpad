import { Bookmark, QueryRequest } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { isFavoriteBookmark, isUnopened } from './use-favorites';
import { useMemo } from 'react';

/**
 * How many favorites have never been opened — the rail's Bookmarks badge.
 *
 * Deliberately queries directly instead of reusing `useFavorites()`, for two
 * reasons:
 *
 * 1. `useProjectBookmarks` carries a reminder auto-reopen effect guarded by a
 *    PER-INSTANCE ref, so each extra mount adds another writer racing to save
 *    the same overdue reminder. The rail is always mounted; it has no business
 *    becoming one of those writers just to read a count.
 * 2. It costs nothing to query again. `WatchedQuery.key` is
 *    `${type}:${queryKey}:${scopeKey}` — `name` is not part of it — so this
 *    resolves to the SAME WatchedQuery, results array and notify fan-out as the
 *    bookmarks slider. Rail and flyout agree structurally rather than by
 *    anyone remembering to keep them in sync, and there's no extra fetch.
 *
 * Unscoped on purpose, matching the Home desktop: the rail badge sits outside
 * the slider's local scope filter, so it counts every favorite the user has.
 */
export function useUnopenedFavoritesCount(): number {
  // Memoized: useEntitiesQuery wants a stable request — an inline one is new
  // every render and can loop useSyncExternalStore into "Maximum update depth
  // exceeded". Matches useAnnotationGutter / InboxView.
  const queryRequest = useMemo(
    () => new QueryRequest({ type: 'bookmark', scope: [], name: 'useUnopenedFavoritesCount' }),
    [],
  );
  const { data: bookmarks = [] } = useEntitiesQuery<Bookmark>(queryRequest);

  return useMemo(
    () => bookmarks.filter((b) => isFavoriteBookmark(b) && isUnopened(b)).length,
    [bookmarks],
  );
}
