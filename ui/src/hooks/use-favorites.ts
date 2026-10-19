import { Bookmark, BookmarkType } from '@sdk';
import { useProject } from '@sdk/react/hooks';
import { sortContainer } from '@src/lib/container-sort';
import { useCallback, useMemo } from 'react';
import { scheduleFavoriteDelete, useHiddenFavoriteIds } from './favorites-pending-delete';
import { useProjectBookmarks } from './use-project-bookmarks';

export interface FavoriteRef {
  entityType: string;
  entityId: string;
  title: string;
  icon?: string;
  nav?: Record<string, unknown>;
}

export function isFavoriteBookmark(b: Bookmark): boolean {
  return b.bookmark_type === BookmarkType.FAVORITE;
}

/** Never opened AND never looked at — the unread predicate behind every
 *  favorites badge. Absent `counter`/`seen` (every row written before those
 *  fields existed) read as 0/false, so a pre-existing favorite correctly
 *  starts out unread. The two are separate on purpose: resting on a row in the
 *  menu clears the badge (`Bookmark.markSeen`) without claiming an open. */
export function isUnopened(b: Bookmark): boolean {
  return (b.counter ?? 0) === 0 && !b.seen;
}

function isFolderBookmark(b: Bookmark): boolean {
  return b.bookmark_type === BookmarkType.FAVORITE_FOLDER;
}

// Stable reference for "no children" so childrenOf() doesn't churn memo deps.
const EMPTY_CHILDREN: Bookmark[] = [];

function matchesRef(b: Bookmark, entityType: string, entityId: string): boolean {
  return (
    b.data?.entity_type === entityType && b.data?.entity_id === entityId
  );
}

/**
 * Favorites are Bookmark records with bookmark_type='favorite'. Unfavoriting is
 * a hard delete (bookmark.delete()) — favorites do not use status/remind_at —
 * written only after the undo window (`favorites-pending-delete.ts`); until
 * then the rows are just hidden.
 *
 * Folders are Bookmark records with bookmark_type='favorite_folder'; a favorite
 * is filed under one via its parent_id. Grouping is CLIENT-side over the one
 * bookmark query (never a `{parent_id: null}` server match — axios drops null
 * operands). Deleting a folder deletes what it holds: removing a grouping the
 * user can see is removing its contents, not scattering them over the root.
 *
 * Backed by useProjectBookmarks, so WebSocket refetch keeps the list live.
 */
export function useFavorites() {
  const { data: allBookmarks, refetch } = useProjectBookmarks();
  // Rows inside an undo window are already gone as far as every surface knows.
  const hidden = useHiddenFavoriteIds();
  const bookmarks = useMemo(
    () => (hidden.size ? allBookmarks.filter((b) => !b.id || !hidden.has(b.id)) : allBookmarks),
    [allBookmarks, hidden],
  );
  // Stamp the current project onto favorites/folders at creation: project_id
  // picks the menu bucket a row lands in. The record still saves unscoped
  // (below) — @local visibility is unchanged; project_id is just a field.
  const { project } = useProject();
  const currentProjectId = project?.id ?? null;

  const favorites = useMemo(() => bookmarks.filter(isFavoriteBookmark), [bookmarks]);

  const folders = useMemo(() => sortContainer(bookmarks.filter(isFolderBookmark)), [bookmarks]);

  const folderIds = useMemo(() => new Set(folders.map((f) => f.id)), [folders]);

  // A dangling parent_id (folder deleted elsewhere before promotion landed)
  // renders at root rather than hiding the favorite/folder.
  const rootFavorites = useMemo(
    () => sortContainer(favorites.filter((b) => !b.parent_id || !folderIds.has(b.parent_id))),
    [favorites, folderIds],
  );

  // Folders that sit at the top level — no parent, or a dangling one. Nested
  // subfolders (parent_id → an existing folder) are rendered inside their
  // parent via `childrenOf`, not at root. Mirror of `rootFavorites`.
  const rootFolders = useMemo(
    () => sortContainer(folders.filter((f) => !f.parent_id || !folderIds.has(f.parent_id))),
    [folders, folderIds],
  );

  // All bookmarks grouped by parent_id (sorted once per group), so `childrenOf` is
  // an O(1) lookup instead of a concat+filter+sort per call — matters because the
  // recursive count badge calls it at every node on every render.
  const childrenByParent = useMemo(() => {
    const map = new Map<string, Bookmark[]>();
    for (const b of [...folders, ...favorites]) {
      const key = b.parent_id ?? '';
      const list = map.get(key);
      if (list) list.push(b);
      else map.set(key, [b]);
    }
    for (const [key, list] of map) map.set(key, sortContainer(list));
    return map;
  }, [folders, favorites]);

  // Direct children of a folder — BOTH nested subfolders and leaf favorites, so a
  // folder tree of arbitrary depth renders and drills down.
  const childrenOf = useCallback(
    (folderId: string): Bookmark[] => childrenByParent.get(folderId) ?? EMPTY_CHILDREN,
    [childrenByParent],
  );

  // Everything filed beneath a folder: its leaves, and its folders (itself
  // included) deepest-first — the order a delete has to go in. The one walk
  // behind both a folder's counts and its delete, so they can't disagree about
  // what it holds. Cycle-guarded (a malformed parent_id loop can't hang render).
  const subtreeOf = useCallback(
    (folderId: string): { leaves: Bookmark[]; folders: Bookmark[] } => {
      const leaves: Bookmark[] = [];
      const folders: Bookmark[] = [];
      const seen = new Set<string>();
      const walk = (id: string) => {
        if (!id || seen.has(id)) return;
        seen.add(id);
        for (const child of childrenByParent.get(id) ?? EMPTY_CHILDREN) {
          if (isFolderBookmark(child)) {
            walk(child.id);
            folders.push(child);
          } else leaves.push(child);
        }
      };
      walk(folderId);
      return { leaves, folders };
    },
    [childrenByParent],
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
    // `parentId` files the favorite directly into a folder ('' = root). The
    // existing-favorite short-circuit ignores it — a duplicate stays where it
    // already lives; callers that want to re-file follow with `moveToFolder`.
    async (ref: FavoriteRef, parentId = ''): Promise<Bookmark> => {
      const existing = isFavorited(ref.entityType, ref.entityId);
      if (existing) return existing;
      const bookmark = new Bookmark({
        bookmark_type: BookmarkType.FAVORITE,
        title: ref.title,
        parent_id: parentId,
        order: appendOrder(parentId),
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

  // `label` is the name the caller shows for the row, so the undo toast names
  // what the user just clicked; the entity's own displayName otherwise.
  const removeFavorite = useCallback(
    (bookmark: Bookmark, label = bookmark.displayName): void => {
      if (!bookmark.id) return;
      scheduleFavoriteDelete({
        ids: [bookmark.id],
        title: label,
        commit: async () => {
          await bookmark.delete();
          await refetch();
        },
      });
    },
    [refetch],
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
    // `parentId` nests the folder ('' = root). This is the only path to a nested
    // folder — `moveToFolder` refuses folders, so a create-then-move workaround
    // can't build one.
    async (name: string, parentId = ''): Promise<Bookmark> => {
      const folder = new Bookmark({
        bookmark_type: BookmarkType.FAVORITE_FOLDER,
        name: name.trim(),
        title: name.trim(),
        parent_id: parentId,
        order: appendOrder(parentId),
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
      // Folders don't move into folders; nesting is built by createFolder only.
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
    (folder: Bookmark, label = folder.displayName): void => {
      if (!folder.id) return;
      // The whole subtree, folders deepest-first after every leaf: each folder is
      // empty by the time it is deleted, so the server's child promotion (kept
      // for the raw API) has nothing to scatter over the root.
      const { leaves, folders: nested } = subtreeOf(folder.id);
      const subfolders = [...nested, folder];
      scheduleFavoriteDelete({
        ids: [...leaves, ...subfolders].map((b) => b.id),
        title: label,
        commit: async () => {
          await Promise.all(leaves.map((b) => b.delete()));
          for (const f of subfolders) await f.delete();
          await refetch();
        },
      });
    },
    [subtreeOf, refetch],
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
    async (ref: FavoriteRef, parentId = ''): Promise<Bookmark | null> => {
      const existing = isFavorited(ref.entityType, ref.entityId);
      if (existing) {
        removeFavorite(existing);
        return null;
      }
      return addFavorite(ref, parentId);
    },
    [isFavorited, addFavorite, removeFavorite],
  );

  return {
    favorites,
    folders,
    rootFolders,
    rootFavorites,
    childrenOf,
    subtreeOf,
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
