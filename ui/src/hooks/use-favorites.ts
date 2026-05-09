import { Bookmark, BookmarkType } from '@sdk';
import { useCallback, useMemo } from 'react';
import { useProjectBookmarks } from './use-project-bookmarks';

export interface FavoriteRef {
  entityType: string;
  entityId: string;
  title: string;
  icon?: string;
  nav?: Record<string, unknown>;
}

function isFavoriteBookmark(b: Bookmark): boolean {
  return b.bookmark_type === BookmarkType.FAVORITE;
}

function matchesRef(b: Bookmark, entityType: string, entityId: string): boolean {
  return (
    b.data?.entity_type === entityType && b.data?.entity_id === entityId
  );
}

/**
 * Favorites are Bookmark records with bookmark_type='favorite'. Unfavoriting is
 * a hard delete (bookmark.delete()) — favorites do not use status/remind_at.
 *
 * Backed by useProjectBookmarks, so WebSocket refetch keeps the list live.
 */
export function useFavorites() {
  const { data: bookmarks, refetch, excludeBookmarks } = useProjectBookmarks();

  const favorites = useMemo(() => bookmarks.filter(isFavoriteBookmark), [bookmarks]);

  const isFavorited = useCallback(
    (entityType: string, entityId: string): Bookmark | undefined =>
      favorites.find((b) => matchesRef(b, entityType, entityId)),
    [favorites],
  );

  const addFavorite = useCallback(
    async (ref: FavoriteRef) => {
      if (isFavorited(ref.entityType, ref.entityId)) return;
      const bookmark = new Bookmark({
        bookmark_type: BookmarkType.FAVORITE,
        title: ref.title,
        data: {
          entity_type: ref.entityType,
          entity_id: ref.entityId,
          icon: ref.icon,
          nav: ref.nav,
        },
      });
      await bookmark.save([]);
      await refetch();
    },
    [isFavorited, refetch],
  );

  const removeFavorite = useCallback(
    async (bookmark: Bookmark) => {
      if (bookmark.id) excludeBookmarks([bookmark.id]);
      await bookmark.delete();
      await refetch();
    },
    [excludeBookmarks, refetch],
  );

  const toggleFavorite = useCallback(
    async (ref: FavoriteRef) => {
      const existing = isFavorited(ref.entityType, ref.entityId);
      if (existing) {
        await removeFavorite(existing);
      } else {
        await addFavorite(ref);
      }
    },
    [isFavorited, addFavorite, removeFavorite],
  );

  return { favorites, isFavorited, addFavorite, removeFavorite, toggleFavorite };
}
