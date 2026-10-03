import { Bookmark, QueryRequest } from '@sdk';
import { useEntitiesQuery, useProject } from '@sdk/react/hooks';
import { isHubOnly } from '@src/navigation/hub-runtime';
import { useEffect, useMemo, useRef } from 'react';

// Stable "no data yet" value, so the sort memo below doesn't churn before load.
const EMPTY: Bookmark[] = [];

/**
 * Hook to fetch all bookmarks visible to the current user.
 *
 * Uses an unscoped query (scope: []) so that bookmarks created via webhook
 * (which are saved under the @local desktop project) are visible even when
 * the user has selected a different project in the sidebar.
 *
 * Reactivity is handled by useEntitiesQuery's watchQuery — when the backend
 * saves a bookmark entity, the DataOpMessage reaches the client via WebSocket
 * and the watched query automatically re-fetches.
 */
export function useProjectBookmarks() {
  const { project } = useProject();
  const projectTypeId = project?.typeId;

  const queryRequest = useMemo(
    () => new QueryRequest({ type: 'bookmark', scope: [], name: 'useProjectBookmarks' }),
    [],
  );

  const { data: bookmarks = EMPTY, refetch } = useEntitiesQuery<Bookmark>(queryRequest, {
    // Hub mode: the hub backend has no `bookmark` entity (graph/bookmark 422s);
    // skip the fetch and fall back to an empty list.
    enabled: !!projectTypeId && !isHubOnly(),
  });

  // Newest first. Memoised on the query's own result array, which keeps its
  // identity until the data changes: a fresh array every render would defeat
  // every memo downstream (useFavorites derives its whole tree from this).
  const sortedBookmarks = useMemo(
    () =>
      [...bookmarks].sort(
        (a, b) => new Date(b.created_date || 0).getTime() - new Date(a.created_date || 0).getTime(),
      ),
    [bookmarks],
  );

  // Auto-reopen pending bookmarks whose remind_at has passed
  const reopenedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const now = Date.now();
    for (const bookmark of sortedBookmarks) {
      if (
        bookmark.status === 'pending' &&
        bookmark.remind_at &&
        new Date(bookmark.remind_at).getTime() <= now &&
        bookmark.id &&
        !reopenedRef.current.has(bookmark.id)
      ) {
        reopenedRef.current.add(bookmark.id);
        bookmark.status = 'open';
        bookmark.remind_at = undefined;
        void bookmark.save([]);
      }
    }
  }, [sortedBookmarks]);

  return { data: sortedBookmarks, refetch };
}
