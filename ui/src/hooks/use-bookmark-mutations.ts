import { Bookmark } from '@sdk';
import { useCallback } from 'react';

interface UseBookmarkMutationsOptions {
  refetch: () => Promise<void>;
  excludeBookmarks: (ids: string[]) => void;
}

/**
 * Centralized bookmark mutation logic with optimistic UI updates.
 * Every mutation: optimistically excludes affected bookmarks, saves to server,
 * then awaits refetch so the UI is in sync before the call resolves.
 *
 * Bookmarks are fetched with an unscoped query (scope: []) so they may belong to
 * any project. Mutations therefore save with an empty scope so that the
 * backend authorises via any valid role path.
 */
export function useBookmarkMutations({ refetch, excludeBookmarks }: UseBookmarkMutationsOptions) {
  const closeBookmark = useCallback(
    async (bookmark: Bookmark) => {
      bookmark.status = 'closed';
      bookmark.closed_at = new Date().toISOString();
      if (bookmark.id) excludeBookmarks([bookmark.id]);
      await bookmark.save([]);
      await refetch();
    },
    [excludeBookmarks, refetch],
  );

  const deleteBookmark = useCallback(
    async (bookmark: Bookmark) => {
      if (bookmark.id) excludeBookmarks([bookmark.id]);
      await bookmark.delete();
      await refetch();
    },
    [excludeBookmarks, refetch],
  );

  const remindBookmark = useCallback(
    async (bookmark: Bookmark, delayMinutes: number) => {
      bookmark.status = 'pending';
      bookmark.remind_at = new Date(Date.now() + delayMinutes * 60_000).toISOString();
      if (bookmark.id) excludeBookmarks([bookmark.id]);
      await bookmark.save([]);
      await refetch();
    },
    [excludeBookmarks, refetch],
  );

  return { closeBookmark, deleteBookmark, remindBookmark };
}
