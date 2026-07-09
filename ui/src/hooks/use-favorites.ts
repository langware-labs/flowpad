import { Bookmark, BookmarkType } from '@sdk';
import { useProject } from '@sdk/react/hooks';
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

import { sortContainer } from '@src/lib/container-sort';

export { sortContainer };

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
  // Stamp the current project onto favorites/folders at creation so the
  // bookmarks slider can filter them by scope. The record still saves unscoped
  // (below) — @local visibility is unchanged; project_id is just a field.
  const { project } = useProject();
  const currentProjectId = project?.id ?? null;

  const favorites = useMemo(() => bookmarks.filter(isFavoriteBookmark), [bookmarks]);

  const folders = useMemo(() => sortContainer(bookmarks.filter(isFolderBookmark)), [bookmarks]);

  const folderIds = useMemo(() => new Set(folders.map((f) => f.id)), [folders]);

  // A dangling parent_id (folder deleted elsewhere before promotion landed)
  // renders at root rather than hiding the favorite.
  const rootFavorites = useMemo(
    () => sortContainer(favorites.filter((b) => !b.parent_id || !folderIds.has(b.parent_id))),
    [favorites, folderIds],
  );

  const childrenOf = useCallback(
    (folderId: string): Bookmark[] => sortContainer(favorites.filter((b) => b.parent_id === folderId)),
    [favorites],
  );

  // Stamp value that lands a new/incoming member at the END of a container
  // that already has manual ordering (OS behavior); 0 keeps it unstamped in a
  // never-ordered container (newest-first fallback).
  const appendOrder = useCallback(
    (parentId: string): number => {
      const siblings = [...folders, ...favorites].filter((b) => (b.parent_id ?? '') === parentId);
      const max = Math.max(0, ...siblings.map((b) => b.order ?? 0));
      return max > 0 ? max + 1 : 0;
    },
    [folders, favorites],
  );

  const isFavorited = useCallback(
    (entityType: string, entityId: string): Bookmark | undefined =>
      favorites.find((b) => matchesRef(b, entityType, entityId)),
    [favorites],
  );

  const addFavorite = useCallback(
    async (ref: FavoriteRef): Promise<Bookmark> => {
      const existing = isFavorited(ref.entityType, ref.entityId);
      if (existing) return existing;
      const bookmark = new Bookmark({
        bookmark_type: BookmarkType.FAVORITE,
        title: ref.title,
        order: appendOrder(''),
        project_id: currentProjectId,
        data: {
          entity_type: ref.entityType,
          entity_id: ref.entityId,
          icon: ref.icon,
          nav: ref.nav,
        },
      });
      await bookmark.save([]);
      await refetch();
      return bookmark;
    },
    [isFavorited, refetch, appendOrder, currentProjectId],
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
        order: appendOrder(''),
        project_id: currentProjectId,
      });
      await folder.save([]);
      await refetch();
      return folder;
    },
    [refetch, appendOrder, currentProjectId],
  );

  const moveToFolder = useCallback(
    async (bookmark: Bookmark, folderId: string | null) => {
      // One nesting level: folders are never filed under folders.
      if (isFolderBookmark(bookmark)) return;
      // Root is '' (never null/undefined) — see parent_id's SDK doc.
      const next = folderId ?? '';
      if ((bookmark.parent_id ?? '') === next) return;
      bookmark.parent_id = next;
      // Land at the end of the target container (OS behavior).
      bookmark.order = appendOrder(next);
      await bookmark.save([]);
      await refetch();
    },
    [refetch, appendOrder],
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

  const reorder = useCallback(
    async (bookmark: Bookmark, anchor: { afterId?: string | null; beforeId?: string | null }, parentId: string) => {
      if (!bookmark.id) return;
      // Cross-container edge drop: move first, then splice into the gap.
      if ((bookmark.parent_id ?? '') !== parentId && !isFolderBookmark(bookmark)) {
        bookmark.parent_id = parentId;
        await bookmark.save([]);
      }
      await Bookmark.reorder(bookmark.id, anchor.afterId ?? null, anchor.beforeId ?? null, parentId);
      await refetch();
    },
    [refetch],
  );

  const toggleFavorite = useCallback(
    async (ref: FavoriteRef): Promise<Bookmark | null> => {
      const existing = isFavorited(ref.entityType, ref.entityId);
      if (existing) {
        await removeFavorite(existing);
        return null;
      }
      return addFavorite(ref);
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
    reorder,
  };
}
