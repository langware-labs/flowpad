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

function isFolderBookmark(b: Bookmark): boolean {
  return b.bookmark_type === BookmarkType.FAVORITE_FOLDER;
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
 * Folders are Bookmark records with bookmark_type='favorite_folder'; a favorite
 * is filed under one via its parent_id. Grouping is CLIENT-side over the one
 * bookmark query (never a `{parent_id: null}` server match — axios drops null
 * operands). Deleting a folder promotes its children to root server-side.
 *
 * Backed by useProjectBookmarks, so WebSocket refetch keeps the list live.
 */
export function useFavorites() {
  const { data: bookmarks, refetch, excludeBookmarks } = useProjectBookmarks();

  const favorites = useMemo(() => bookmarks.filter(isFavoriteBookmark), [bookmarks]);

  const folders = useMemo(() => bookmarks.filter(isFolderBookmark), [bookmarks]);

  const folderIds = useMemo(() => new Set(folders.map((f) => f.id)), [folders]);

  // A dangling parent_id (folder deleted elsewhere before promotion landed)
  // renders at root rather than hiding the favorite.
  const rootFavorites = useMemo(
    () => favorites.filter((b) => !b.parent_id || !folderIds.has(b.parent_id)),
    [favorites, folderIds],
  );

  const childrenOf = useCallback(
    (folderId: string): Bookmark[] => favorites.filter((b) => b.parent_id === folderId),
    [favorites],
  );

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

  const renameFavorite = useCallback(
    async (bookmark: Bookmark, newName: string) => {
      const next = newName.trim();
      if (!next || bookmark.name === next) return;
      bookmark.name = next;
      await bookmark.save([]);
      await refetch();
    },
    [refetch],
  );

  const createFolder = useCallback(
    async (name: string): Promise<Bookmark> => {
      const folder = new Bookmark({
        bookmark_type: BookmarkType.FAVORITE_FOLDER,
        name: name.trim(),
        title: name.trim(),
      });
      await folder.save([]);
      await refetch();
      return folder;
    },
    [refetch],
  );

  const moveToFolder = useCallback(
    async (bookmark: Bookmark, folderId: string | null) => {
      // One nesting level: folders are never filed under folders.
      if (isFolderBookmark(bookmark)) return;
      // Root is '' (never null/undefined) — see parent_id's SDK doc.
      const next = folderId ?? '';
      if ((bookmark.parent_id ?? '') === next) return;
      bookmark.parent_id = next;
      await bookmark.save([]);
      await refetch();
    },
    [refetch],
  );

  const deleteFolder = useCallback(
    async (folder: Bookmark) => {
      // Children are promoted to root server-side (Bookmark.delete override) —
      // exclude only the folder itself so its members re-render at root.
      if (folder.id) excludeBookmarks([folder.id]);
      await folder.delete();
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

  return {
    favorites,
    folders,
    rootFavorites,
    childrenOf,
    refetch,
    isFavorited,
    addFavorite,
    removeFavorite,
    renameFavorite,
    toggleFavorite,
    createFolder,
    moveToFolder,
    deleteFolder,
  };
}
