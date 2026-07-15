import { Bookmark, QueryRequest, dataContext } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { defaultScopeFilter } from '@src/lib/scope-filter';
import { bookmarkInScope } from '@src/lib/bookmark-scope';
import { isFavoriteBookmark, isUnopened } from './use-favorites';
import { useMemo } from 'react';

/**
 * How many never-opened favorites are in scope — the rail's Bookmarks badge.
 *
 * Scoped to the current project, via the same `defaultScopeFilter` the menu
 * seeds itself with: the badge is a summary of what opening the menu will show,
 * so counting favorites the menu then filters out would be lying. (An unscoped
 * favorite is personal and counts under every project — see `bookmarkInScope`.)
 * The menu's scope is local, user-togglable state, so flipping it to "All"
 * makes it show more than the badge counts; the badge tracks the default view,
 * which is the one it stands for.
 *
 * Queries directly instead of reusing `useFavorites()`, for two reasons:
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
 */
export function useUnopenedFavoritesCount(): number {
  // The query itself stays unscoped (`scope: []`) — bookmarks save unscoped, so
  // project selection is a client-side filter over `project_id`, not a server
  // scope. Keeping it unscoped is also what shares the WatchedQuery above.
  const queryRequest = useMemo(
    () => new QueryRequest({ type: 'bookmark', scope: [], name: 'useUnopenedFavoritesCount' }),
    [],
  );
  const { data: bookmarks = [] } = useEntitiesQuery<Bookmark>(queryRequest);

  const currentProjectId = dataContext.project?.id ?? null;
  const scope = useMemo(() => defaultScopeFilter(currentProjectId), [currentProjectId]);

  return useMemo(
    () =>
      bookmarks.filter(
        (b) => isFavoriteBookmark(b) && isUnopened(b) && bookmarkInScope(b, scope, currentProjectId),
      ).length,
    [bookmarks, scope, currentProjectId],
  );
}
