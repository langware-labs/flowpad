import { Bookmark, QueryRequest } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { isHubOnly } from '@src/navigation/hub-runtime';
import { defaultScopeFilter } from '@src/lib/scope-filter';
import { bookmarkInScope } from '@src/lib/bookmark-scope';
import { useContext } from './useContext';
import { canNavigateFavorite } from '@src/navigation/favorite-nav';
import { useHiddenFavoriteIds } from './favorites-pending-delete';
import { isFavoriteBookmark, isUnopened } from './use-favorites';
import { useMemo } from 'react';

/**
 * How many never-opened favorites are new HERE — the nav star's badge.
 *
 * Counts the current project's favorites plus the personal (unscoped) ones:
 * the two buckets that belong to where you are. Other projects' buckets carry
 * their own badges inside the menu. Rows the menu cannot show (inside an undo
 * window, or with a target that no longer resolves) never count.
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
 *    bookmarks menu. Rail and flyout agree structurally rather than by
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
  // Hub mode: `bookmark` is a local-only entity (422 on the hub) — skip the fetch.
  const { data: bookmarks = [] } = useEntitiesQuery<Bookmark>(queryRequest, { enabled: !isHubOnly() });

  // Keep the badge reactive when the user switches projects without a bookmark
  // update. Reading dataContext directly would leave the old count on screen.
  const { project } = useContext();
  const currentProjectId = project?.id ?? null;
  const scope = useMemo(() => defaultScopeFilter(currentProjectId), [currentProjectId]);
  // Count only what the menu can show: not a row inside an undo window, not a
  // favorite whose target no longer resolves (the menu hides those).
  const hidden = useHiddenFavoriteIds();

  return useMemo(
    () =>
      bookmarks.filter(
        (b) =>
          isFavoriteBookmark(b) &&
          isUnopened(b) &&
          !(b.id && hidden.has(b.id)) &&
          bookmarkInScope(b, scope, currentProjectId) &&
          // Last: it parses the stored pointer, so only for rows still counted.
          canNavigateFavorite(b),
      ).length,
    [bookmarks, hidden, scope, currentProjectId],
  );
}
