import { BookmarkType, type Bookmark } from '@sdk';
import {
  summaryForBookmark,
  useFavoriteSummaries,
} from '@src/hooks/use-favorite-summaries';
import { sortContainer, useFavorites } from '@src/hooks/use-favorites';
import {
  canNavigateFavorite,
  navigateToFavorite,
  pointerForFavorite,
} from '@src/navigation/favorite-nav';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { formatTimeAgo } from '@src/utils/format-time-ago';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  Bookmark as BookmarkIcon,
  Box,
  FileText,
  Folder,
  FolderKanban,
  GitBranch,
  Hammer,
  Layers,
  MessageSquare,
  Package,
  Star,
  StickyNote,
  Terminal,
  Trash2,
  Workflow,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useMemo } from 'react';
import type { BrowseableDragData, BrowseableRoot } from '../types';

const ICON_BY_NAME: Record<string, LucideIcon> = {
  Bookmark: BookmarkIcon,
  Box,
  FileText,
  FolderKanban,
  GitBranch,
  Hammer,
  Layers,
  MessageSquare,
  Package,
  StickyNote,
  Terminal,
  Workflow,
  Zap,
};

const ICON_BY_ENTITY_TYPE: Record<string, LucideIcon> = {
  project: FolderKanban,
  asset: Package,
  skill: Layers,
  agent: Hammer,
  task: MessageSquare,
  workflow: Workflow,
  agentic_process: Terminal,
  claude_session: Terminal,
  collaboration_room: MessageSquare,
  trigger: Zap,
  bookmark: BookmarkIcon,
  plan: FileText,
  command: Terminal,
  claude_hook: Zap,
};

function resolveIcon(bookmark: Bookmark): LucideIcon {
  const explicit = bookmark.data?.icon as string | undefined;
  if (explicit && ICON_BY_NAME[explicit]) return ICON_BY_NAME[explicit];
  const entityType = bookmark.data?.entity_type as string | undefined;
  if (entityType && ICON_BY_ENTITY_TYPE[entityType]) return ICON_BY_ENTITY_TYPE[entityType];
  return BookmarkIcon;
}

export const FAVORITE_DRAG_KIND = 'favorite';

/** The drag payload for a favorite tile/row. */
function favoriteDragData(b: Bookmark, label: string): BrowseableDragData {
  return { kind: FAVORITE_DRAG_KIND, id: b.id ?? '', label };
}

/**
 * favoritesRoot adapter — exposes the favorites desktop (folders + favorite
 * bookmarks) as Browseable containers, so any Browseable renderer (the desktop
 * grid, a navigator tree) can host it: one container contract, OS-style.
 *
 * Deliberately a HOOK over live `useFavorites()` state, never a static
 * closure: WS `update` ops don't notify query watchers, so every mutation
 * must run through this owning instance — its `refetch` re-renders whatever
 * surface consumes the returned roots. Children derive from live state (the
 * `listChildren` closures are rebuilt when the data changes), so no
 * refresh-store wiring is needed.
 */
export const FOLDER_DRAG_KIND = 'favorite_folder';

export function useFavoritesRoots(): {
  roots: BrowseableRoot[];
  /** Drop on the surface background = un-file back to root. */
  onDropToBackground: (drag: BrowseableDragData) => void;
  /** Edge-drop reorder within the root container (folders + unfiled tiles). */
  onReorderRoot: (
    drag: BrowseableDragData,
    anchor: { afterId?: string; beforeId?: string },
  ) => Promise<void>;
} {
  const { navigation } = useDockNavigation();
  const { t } = useLingui();
  const {
    favorites,
    folders,
    rootFavorites,
    childrenOf,
    removeFavorite,
    renameFavorite,
    moveToFolder,
    deleteFolder,
    reorder,
  } = useFavorites();
  const summaries = useFavoriteSummaries(favorites);

  return useMemo(() => {
    const asLeaf = (b: Bookmark): BrowseableRoot => {
      const summary = summaryForBookmark(b, summaries);
      const title = b.name || summary?.name || b.displayName;
      const navigable = canNavigateFavorite(b);
      const pointer = navigable ? pointerForFavorite(b) : null;
      const Icon = navigable ? resolveIcon(b) : X;
      const createdAgo = formatTimeAgo(b.created_date);
      const node: BrowseableRoot = {
        kind: 'root',
        id: b.id ?? '',
        label: title,
        icon: <Icon className="h-6 w-6" />,
        rowClassName: navigable ? undefined : 'opacity-60 cursor-not-allowed',
        hasChildren: false,
        pointer,
        // Session-like types can't be expressed as a pure pointer — fall back
        // to the imperative dispatcher (protocol's documented activate arm).
        activate:
          !pointer && navigable ? () => navigateToFavorite(b, navigation) : undefined,
        selectionKey: b.id,
        onRename: (next) => renameFavorite(b, next),
        dragData: favoriteDragData(b, title),
        toolbar: [
          {
            id: 'remove-favorite',
            icon: navigable ? <Star className="h-3 w-3 fill-current text-amber-500" /> : <X className="h-3 w-3" />,
            label: t`Remove favorite`,
            run: () => removeFavorite(b),
          },
          // Filed leaves also offer menu-based un-filing (drag-out works too).
          ...(b.parent_id
            ? [
                {
                  id: 'remove-from-folder',
                  icon: <Folder className="h-3 w-3" />,
                  label: t`Remove from folder`,
                  run: () => moveToFolder(b, null),
                },
              ]
            : []),
        ],
        tooltip: (
          <>
            <div className="text-xs font-medium">{navigable ? title : `${title} ${t`(missing)`}`}</div>
            {summary?.subtitle && (
              <div className="mt-0.5 line-clamp-3 text-[11px] opacity-80">{summary.subtitle}</div>
            )}
            {createdAgo && (
              <div className="mt-1 text-[10px] opacity-60">
                <Trans>Favorited {createdAgo}</Trans>
              </div>
            )}
          </>
        ),
        ownsPointer: (p) =>
          !!pointer && p.viewType === pointer.viewType && p.pointer === pointer.pointer,
        pathFor: () => Promise.resolve([node]),
      };
      return node;
    };

    const asFolder = (folder: Bookmark): BrowseableRoot => {
      const title = folder.name || folder.title || folder.displayName;
      const children = folder.id ? childrenOf(folder.id) : [];
      const node: BrowseableRoot = {
        kind: 'root',
        id: folder.id ?? '',
        // The grid keys folder behavior off this; kept distinct from leaves.
        selectionType: 'favorite_folder',
        label: title,
        icon: <Folder className="h-6 w-6" />,
        badge:
          children.length > 0 ? (
            <span className="rounded-full bg-primary px-1 text-[9px] font-semibold leading-[13px] text-primary-foreground">
              {children.length}
            </span>
          ) : undefined,
        hasChildren: children.length > 0 ? true : 'unknown',
        listChildren: () => Promise.resolve(children.map(asLeaf)),
        pointer: null,
        onRename: (next) => renameFavorite(folder, next),
        // Draggable for root reordering only — canDrop's kind gate keeps
        // folders out of folders (one nesting level).
        dragData: { kind: FOLDER_DRAG_KIND, id: folder.id ?? '', label: title },
        reorderChildren: async (dragId, anchor) => {
          const dragged = favorites.find((b) => b.id === dragId);
          if (dragged) await reorder(dragged, anchor, folder.id ?? '');
        },
        canDrop: (drag) => drag.kind === FAVORITE_DRAG_KIND && drag.id !== folder.id,
        onDrop: async (drag) => {
          const dragged = favorites.find((b) => b.id === drag.id);
          if (dragged) await moveToFolder(dragged, folder.id ?? null);
        },
        toolbar: [
          {
            id: 'delete-folder',
            icon: <Trash2 className="h-3 w-3" />,
            label: t`Delete folder`,
            run: () => deleteFolder(folder),
          },
        ],
        tooltip: (
          <div className="text-xs font-medium">
            <Trans>
              {title} — {children.length} items
            </Trans>
          </div>
        ),
        ownsPointer: () => false,
        pathFor: () => Promise.resolve([node]),
      };
      return node;
    };

    const onDropToBackground = (drag: BrowseableDragData) => {
      if (drag.kind !== FAVORITE_DRAG_KIND) return;
      const dragged = favorites.find((b) => b.id === drag.id);
      if (dragged && dragged.parent_id) void moveToFolder(dragged, null);
    };

    const onReorderRoot = async (
      drag: BrowseableDragData,
      anchor: { afterId?: string; beforeId?: string },
    ) => {
      const dragged =
        favorites.find((b) => b.id === drag.id) ?? folders.find((f) => f.id === drag.id);
      if (dragged) await reorder(dragged, anchor, '');
    };

    return {
      // One root container, OS-style: folders and unfiled favorites share the
      // manual order — sort the combined sibling set with the same container
      // comparator the backend uses, then render each by its shape.
      roots: sortContainer([...folders, ...rootFavorites]).map((b) =>
        b.bookmark_type === BookmarkType.FAVORITE_FOLDER ? asFolder(b) : asLeaf(b),
      ),
      onDropToBackground,
      onReorderRoot,
    };
  }, [
    favorites,
    folders,
    rootFavorites,
    childrenOf,
    summaries,
    navigation,
    removeFavorite,
    renameFavorite,
    moveToFolder,
    deleteFolder,
    reorder,
    t,
  ]);
}
