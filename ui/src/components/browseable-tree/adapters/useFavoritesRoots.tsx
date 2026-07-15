import { BookmarkType, type Bookmark } from '@sdk';
import {
  summaryForBookmark,
  useFavoriteSummaries,
} from '@src/hooks/use-favorite-summaries';
import { isUnopened, sortContainer, useFavorites } from '@src/hooks/use-favorites';
import {
  canNavigateFavorite,
  navigateToFavorite,
  pointerForFavorite,
} from '@src/navigation/favorite-nav';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { lucideByName } from '@src/lib/lucide-by-name';
import { formatTimeAgo } from '@src/utils/format-time-ago';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  Bookmark as BookmarkIcon,
  Folder,
  Star,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useMemo, useRef } from 'react';
import type { Browseable, BrowseableDragData, BrowseableRoot } from '../types';

/** Explicit `data.icon` name wins; otherwise the target type's registry icon
 *  (backend TypeInfo via the bootstrap-loaded SchemaRegistry — never a
 *  hardcoded per-type map, per the type-icons rule). */
function resolveIcon(bookmark: Bookmark): LucideIcon {
  const explicit = bookmark.data?.icon as string | undefined;
  if (explicit) return lucideByName(explicit);
  const entityType = bookmark.data?.entity_type as string | undefined;
  return entityType ? iconForType(entityType) : BookmarkIcon;
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
 * closure: a mutation only re-renders the consuming surface if it runs through
 * this owning instance — either its `refetch` or a `notifyEntityChanged`, since
 * a save's own WS echo is not a reliable trigger (see `markOpened`). Children
 * derive from live state (the `listChildren` closures are rebuilt when the data
 * changes), so no refresh-store wiring is needed.
 */
export const FOLDER_DRAG_KIND = 'favorite_folder';

/** Stable identity so the default (unfiltered) case never churns the roots memo. */
const PASS_ALL = (): boolean => true;

export function useFavoritesRoots(opts?: {
  /** Optional visibility predicate (e.g. a scope filter) applied to the leaves
   *  and folders that get rendered; children are filtered too. Lookups for drag
   *  targets still use the full favorite set. Default (unset) renders all. */
  filter?: (b: Bookmark) => boolean;
  /** Icon sizing. Defaults to the 64px desktop tile's `h-6 w-6`; a tree menu
   *  passes `h-4 w-4` — its rows are `text-xs` with `h-3` chevrons, so a 24px
   *  icon would tower over every row. */
  iconClassName?: string;
}): {
  roots: Browseable[];
  /** Drop on the surface background = un-file back to root. */
  onDropToBackground: (drag: BrowseableDragData) => void;
  /** Edge-drop reorder within the root container (folders + unfiled tiles). */
  onReorderRoot: (
    drag: BrowseableDragData,
    anchor: { afterId?: string; beforeId?: string },
  ) => Promise<void>;
} {
  const filter = opts?.filter ?? PASS_ALL;
  const iconClassName = opts?.iconClassName ?? 'h-6 w-6';
  const { navigation } = useDockNavigation();
  // navigation's identity changes on every dock change (it carries
  // currentDock); read it through a ref inside the activate closures so URL
  // changes don't rebuild every tile.
  const navigationRef = useRef(navigation);
  navigationRef.current = navigation;
  const { t } = useLingui();
  const {
    favorites,
    folders,
    rootFolders,
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
    const asLeaf = (b: Bookmark): Browseable => {
      const summary = summaryForBookmark(b, summaries);
      const title = b.name || summary?.name || b.displayName;
      const navigable = canNavigateFavorite(b);
      const pointer = navigable ? pointerForFavorite(b) : null;
      const Icon = navigable ? resolveIcon(b) : X;
      const createdAgo = formatTimeAgo(b.created_date);
      return {
        kind: 'favorite',
        id: b.id ?? '',
        label: title,
        icon: <Icon className={iconClassName} />,
        // Unread dot — the leaf-level form of the folder count badge. The grid
        // renders `badge` for leaves and folders alike, so no renderer change.
        badge: isUnopened(b) ? (
          <span className="block h-2 w-2 rounded-full bg-primary" />
        ) : undefined,
        rowClassName: navigable ? undefined : 'opacity-60 cursor-not-allowed',
        hasChildren: false,
        pointer,
        // Fires for BOTH the pointer and activate arms — the whole reason
        // `onOpen` exists, since most favorites navigate via the pure pointer
        // arm, which calls no adapter code.
        onOpen: () => void b.markOpened(),
        // Session-like types can't be expressed as a pure pointer — fall back
        // to the imperative dispatcher (protocol's documented activate arm).
        activate:
          !pointer && navigable
            ? () => navigateToFavorite(b, navigationRef.current)
            : undefined,
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
      };
    };

    // The visible LEAF favorites under a folder, descending through nested
    // subfolders — so `Auto` sees everything filed beneath it while each
    // `Auto/<type>` sees only its own. Cycle-guarded (a malformed parent_id
    // loop can't hang render). Callers count what they need off the result.
    const leavesUnder = (folderId: string, seen: Set<string> = new Set()): Bookmark[] => {
      if (!folderId || seen.has(folderId)) return [];
      seen.add(folderId);
      return childrenOf(folderId)
        .filter(filter)
        .flatMap((k) =>
          k.bookmark_type === BookmarkType.FAVORITE_FOLDER ? leavesUnder(k.id ?? '', seen) : [k],
        );
    };

    const asFolder = (folder: Bookmark): Browseable => {
      const title = folder.name || folder.title || folder.displayName;
      const allChildren = folder.id ? childrenOf(folder.id) : [];
      const children = allChildren.filter(filter);
      // The badge counts only what's NEVER been opened, so an all-opened folder
      // carries no badge (like a fully-read inbox); the tooltip still reports
      // full membership.
      const leaves = folder.id ? leavesUnder(folder.id) : [];
      const unopened = leaves.filter(isUnopened).length;
      return {
        kind: 'favorite_folder',
        id: folder.id ?? '',
        label: title,
        icon: <Folder className={iconClassName} />,
        badge:
          unopened > 0 ? (
            <span className="rounded-full bg-primary px-1 text-[9px] font-semibold leading-[13px] text-primary-foreground">
              {unopened}
            </span>
          ) : undefined,
        hasChildren: children.length > 0 ? true : 'unknown',
        // Render nested subfolders as folders (recursive) and leaves as tiles.
        listChildren: () =>
          Promise.resolve(
            children.map((c) => (c.bookmark_type === BookmarkType.FAVORITE_FOLDER ? asFolder(c) : asLeaf(c))),
          ),
        pointer: null,
        selectionKey: folder.id,
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
              {title} — {leaves.length} items
            </Trans>
          </div>
        ),
      };
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

    // Only TOP-LEVEL folders render at root; nested subfolders surface inside
    // their parent via asFolder's recursive listChildren.
    const visibleFolders = rootFolders.filter(filter);
    const visibleRootFavorites = rootFavorites.filter(filter);

    return {
      // One root container, OS-style: folders and unfiled favorites share the
      // manual order — sort the combined sibling set with the same container
      // comparator the backend uses, then render each by its shape.
      roots: sortContainer([...visibleFolders, ...visibleRootFavorites]).map((b) =>
        b.bookmark_type === BookmarkType.FAVORITE_FOLDER ? asFolder(b) : asLeaf(b),
      ),
      onDropToBackground,
      onReorderRoot,
    };
  }, [
    favorites,
    folders,
    rootFolders,
    rootFavorites,
    childrenOf,
    summaries,
    removeFavorite,
    renameFavorite,
    moveToFolder,
    deleteFolder,
    reorder,
    filter,
    iconClassName,
    t,
  ]);
}

/**
 * The same favorites, shaped for BrowseableTree (the menu renderer) rather than
 * the grid.
 *
 * `BrowseableRoot` requires `ownsPointer`/`pathFor`, which exist only to power
 * deep-link auto-expand. Both are no-ops here: the slider closes on the first
 * navigation, so nothing ever deep-links into an open menu. Row highlighting is
 * a pure pointer-string match and still works. Only top-level nodes must be
 * roots — `listChildren` keeps handing back plain `Browseable`s.
 */
export function useFavoritesTreeRoots(opts?: { filter?: (b: Bookmark) => boolean }): BrowseableRoot[] {
  const { roots } = useFavoritesRoots({ filter: opts?.filter, iconClassName: 'h-4 w-4' });
  return useMemo(
    () =>
      roots.map((n) => ({
        ...n,
        kind: 'root' as const,
        ownsPointer: () => false,
        pathFor: () => Promise.resolve([]),
      })),
    [roots],
  );
}
