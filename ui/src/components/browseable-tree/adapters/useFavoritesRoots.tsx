import { BookmarkType, Project, QueryRequest, type Bookmark } from '@sdk';
import {
  summaryForBookmark,
  useFavoriteSummaries,
} from '@src/hooks/use-favorite-summaries';
import { isUnopened, useFavorites } from '@src/hooks/use-favorites';
import { sortContainer } from '@src/lib/container-sort';
import {
  canNavigateFavorite,
  navigateToFavorite,
  pointerForFavorite,
} from '@src/navigation/favorite-nav';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useContext as useDataContext } from '@sdk/react/hooks';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { lucideByName } from '@src/lib/lucide-by-name';
import { formatTimeAgo } from '@src/utils/format-time-ago';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import {
  Bookmark as BookmarkIcon,
  Folder,
  Star,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useMemo, useRef, type ReactNode } from 'react';
import { refreshNode } from '../refresh-store';
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

/**
 * The "never opened" count badge, shared by every favorites container (folders
 * and project buckets) so its contrast fix lives in one place.
 *
 * NOT `bg-primary`/`text-primary-foreground` (the shadcn default this used to
 * carry): `useColorPalette` lightens `--primary` for dark mode without
 * lightening `--primary-foreground`, so that pairing is white on pale lavender
 * — 1.9:1 — in dark. The digit was invisible, which is why the badge read as a
 * featureless dot; the 9px size was a red herring. `muted` is the only pairing
 * that clears AA in both themes, and a count is information rather than an
 * alarm.
 */
function unopenedBadge(count: number): ReactNode | undefined {
  if (count <= 0) return undefined;
  return (
    <span className="min-w-[1.25rem] rounded-full bg-muted px-1.5 py-0.5 text-center text-[11px] font-semibold leading-none text-muted-foreground">
      {count}
    </span>
  );
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
  /** Navigation menus contain only paths to visible favorite links. */
  hideEmptyFolders?: boolean;
  /** Icon sizing. Defaults to the 64px desktop tile's `h-6 w-6`; a tree menu
   *  passes `h-4 w-4` — its rows are `text-xs` with `h-3` chevrons, so a 24px
   *  icon would tower over every row. */
  iconClassName?: string;
}): {
  roots: Browseable[];
  /** The flat rows behind `roots`, already fetched and sorted here. Exposed so a
   *  caller that needs to regroup them (see `useFavoritesProjectRoots`) reads
   *  this hook's data instead of calling `useFavorites()` again — that second
   *  call opens its own watched bookmark query and re-derives every list on
   *  every update, for bytes this hook already has. */
  favorites: Bookmark[];
  folders: Bookmark[];
  /** Ids of the favorites whose target resolves — parsed once here, so a
   *  regrouping caller never re-parses every pointer to ask the same thing. */
  navigableIds: ReadonlySet<string>;
  /** `useFavorites().subtreeOf`, passed through for the same reason. */
  subtreeOf: (folderId: string) => { leaves: Bookmark[]; folders: Bookmark[] };
  /** A folder's visible rows, synchronously — what its `listChildren` resolves
   *  to, for a caller that renders one level at a time instead of expanding. */
  folderRows: (folderId: string) => Browseable[];
  /** Drop on the surface background = un-file back to root. */
  onDropToBackground: (drag: BrowseableDragData) => void;
  /** Edge-drop reorder within the root container (folders + unfiled tiles). */
  onReorderRoot: (
    drag: BrowseableDragData,
    anchor: { afterId?: string; beforeId?: string },
  ) => Promise<void>;
} {
  const filter = opts?.filter ?? PASS_ALL;
  const hideEmptyFolders = opts?.hideEmptyFolders ?? false;
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
    subtreeOf,
    removeFavorite,
    renameFavorite,
    moveToFolder,
    deleteFolder,
    reorder,
  } = useFavorites();
  const summaries = useFavoriteSummaries(favorites);

  return useMemo(() => {
    // A membership change removes/adds a row inside a folder. The tree caches an
    // expanded folder's children (unlike the grid, which reloads on node
    // identity), so it must be told to reload that folder — root-level rows
    // update via the live `roots` prop, so only real folder ids need this.
    const refreshFolder = (folderId?: string | null) => {
      if (folderId) refreshNode(folderId);
    };
    // A leaf favorite whose pointer resolves nowhere is a dead "ghost" — never
    // render it, and never count it. It is NOT deleted: opening a menu must not
    // destroy data, and a type this build can't open may be one the next build
    // can. Folders carry no target ref, so they bypass the check.
    //
    // `canNavigateFavorite` parses the stored pointer (JSON + Date allocs), and
    // the overlapping filter/leaf paths would otherwise re-run it several times
    // per leaf per render — resolve it once per favorite into a lookup set.
    const navigableIds = new Set(favorites.filter(canNavigateFavorite).map((b) => b.id));
    const populatedFolders = new Set<string>();
    if (hideEmptyFolders) {
      const byId = new Map(folders.map((folder) => [folder.id, folder]));
      for (const favorite of favorites) {
        if (!filter(favorite) || !navigableIds.has(favorite.id)) continue;
        const seen = new Set<string>();
        let parent = favorite.parent_id;
        while (parent && !seen.has(parent)) {
          seen.add(parent);
          const folder = byId.get(parent);
          if (!folder || !filter(folder)) break;
          populatedFolders.add(parent);
          parent = folder.parent_id;
        }
      }
    }
    const isVisible = (b: Bookmark): boolean =>
      filter(b) &&
      (b.bookmark_type === BookmarkType.FAVORITE_FOLDER
        ? !hideEmptyFolders || populatedFolders.has(b.id ?? '')
        : navigableIds.has(b.id));
    const asLeaf = (b: Bookmark): Browseable => {
      const summary = summaryForBookmark(b, summaries);
      const title = b.name || summary?.name || b.displayName;
      const navigable = navigableIds.has(b.id);
      const pointer = navigable ? pointerForFavorite(b) : null;
      const Icon = navigable ? resolveIcon(b) : X;
      const createdAgo = formatTimeAgo(b.created_date);
      return {
        kind: 'favorite',
        id: b.id ?? '',
        label: title,
        icon: <Icon className={iconClassName} />,
        rowClassName: navigable ? undefined : 'opacity-60 cursor-not-allowed',
        hasChildren: false,
        pointer,
        // Fires for BOTH the pointer and activate arms — the whole reason
        // `onOpen` exists, since most favorites navigate via the pure pointer
        // arm, which calls no adapter code.
        onOpen: () => void b.markOpened(),
        // Resting on the row clears its badge without counting as an open.
        onHoverSeen: () => void b.markSeen(),
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
            destructive: true,
            run: () => {
              removeFavorite(b, title);
              refreshFolder(b.parent_id);
            },
          },
          // Filed leaves also offer menu-based un-filing (drag-out works too).
          ...(b.parent_id
            ? [
                {
                  id: 'remove-from-folder',
                  icon: <Folder className="h-3 w-3" />,
                  label: t`Remove from folder`,
                  run: async () => {
                    const from = b.parent_id;
                    await moveToFolder(b, null);
                    refreshFolder(from);
                  },
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

    // The visible LEAF favorites under a folder, through nested subfolders —
    // the same walk the folder's delete removes (`subtreeOf`).
    const leavesUnder = (folderId: string): Bookmark[] => subtreeOf(folderId).leaves.filter(isVisible);

    const asNode = (b: Bookmark): Browseable =>
      b.bookmark_type === BookmarkType.FAVORITE_FOLDER ? asFolder(b) : asLeaf(b);
    const asFolder = (folder: Bookmark): Browseable => {
      const title = folder.name || folder.title || folder.displayName;
      const children = folder.id ? childrenOf(folder.id).filter(isVisible) : [];
      // The badge counts only what's NEVER been opened, so an all-opened folder
      // carries no badge (like a fully-read stream inbox); the tooltip still reports
      // full membership.
      const leaves = folder.id ? leavesUnder(folder.id) : [];
      const unopened = leaves.filter(isUnopened).length;
      return {
        kind: 'favorite_folder',
        id: folder.id ?? '',
        label: title,
        icon: <Folder className={iconClassName} />,
        // How many items beneath have never been opened.
        badge: unopenedBadge(unopened),
        hasChildren: children.length > 0 ? true : 'unknown',
        // Render nested subfolders as folders (recursive) and leaves as tiles.
        listChildren: () => Promise.resolve(children.map(asNode)),
        pointer: null,
        selectionKey: folder.id,
        onRename: (next) => renameFavorite(folder, next),
        // Draggable for root reordering only — canDrop's kind gate keeps a
        // dragged folder out of another folder (nesting is built by createFolder).
        dragData: { kind: FOLDER_DRAG_KIND, id: folder.id ?? '', label: title },
        reorderChildren: async (dragId, anchor) => {
          const dragged = favorites.find((b) => b.id === dragId);
          if (!dragged) return;
          await reorder(dragged, anchor, folder.id ?? '');
          refreshFolder(folder.id);
        },
        canDrop: (drag) => drag.kind === FAVORITE_DRAG_KIND && drag.id !== folder.id,
        onDrop: async (drag) => {
          const dragged = favorites.find((b) => b.id === drag.id);
          if (!dragged) return;
          const from = dragged.parent_id;
          await moveToFolder(dragged, folder.id ?? null);
          refreshFolder(from);
          refreshFolder(folder.id);
        },
        toolbar: [
          {
            id: 'delete-folder',
            icon: <Trash2 className="h-3 w-3" />,
            label: t`Delete folder`,
            destructive: true,
            run: () => {
              deleteFolder(folder, title);
              refreshFolder(folder.parent_id);
            },
          },
        ],
        // The SAME two numbers the menu shows, from the same visible leaves: the
        // badge is the unopened count, and the tooltip names both, so neither
        // can read as a different set of rows from the other.
        tooltip: (
          <div className="text-xs font-medium">
            {title} — <Plural value={leaves.length} one="# item" other="# items" />
            {unopened > 0 && (
              <>
                {' · '}
                <Trans>{unopened} new</Trans>
              </>
            )}
          </div>
        ),
      };
    };

    const onDropToBackground = (drag: BrowseableDragData) => {
      if (drag.kind !== FAVORITE_DRAG_KIND) return;
      const dragged = favorites.find((b) => b.id === drag.id);
      if (dragged && dragged.parent_id) {
        const from = dragged.parent_id;
        void moveToFolder(dragged, null).then(() => refreshFolder(from));
      }
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
    const visibleFolders = rootFolders.filter(isVisible);
    const visibleRootFavorites = rootFavorites.filter(isVisible);

    return {
      // One root container, OS-style: folders and unfiled favorites share the
      // manual order — sort the combined sibling set with the same container
      // comparator the backend uses, then render each by its shape.
      roots: sortContainer([...visibleFolders, ...visibleRootFavorites]).map(asNode),
      favorites,
      folders,
      navigableIds,
      subtreeOf,
      folderRows: (folderId: string) => childrenOf(folderId).filter(isVisible).map(asNode),
      onDropToBackground,
      onReorderRoot,
    };
  }, [
    favorites,
    folders,
    rootFolders,
    rootFavorites,
    childrenOf,
    subtreeOf,
    summaries,
    removeFavorite,
    renameFavorite,
    moveToFolder,
    deleteFolder,
    reorder,
    filter,
    hideEmptyFolders,
    iconClassName,
    t,
  ]);
}

/** Node-id prefix for a project bucket, so a bucket id can never collide with a
 *  bookmark id. Private: what a caller actually wants to know is answered by
 *  `addParentFor`, not by inspecting how an id is spelled. */
const FAVORITES_BUCKET_PREFIX = 'favproject:';
/** The bucket holding favorites that carry no `project_id` — everything written
 *  before project stamping existed, plus anything bookmarked outside a project. */
const FAVORITES_PERSONAL_BUCKET = `${FAVORITES_BUCKET_PREFIX}personal`;

function favoritesBucketId(projectId: string): string {
  return projectId ? `${FAVORITES_BUCKET_PREFIX}${projectId}` : FAVORITES_PERSONAL_BUCKET;
}

const NO_PROJECTS: Project[] = [];

/**
 * The favorites tree as it is actually stored: ONE GLOBAL desk, grouped by the
 * project each top-level row belongs to.
 *
 * This replaces the scope-filter header the bookmarks menu used to carry. A
 * filter answers "which project am I looking at?" with a mode you first have to
 * set; the tree answers it with structure — the menu opens on the current
 * project's bucket (`currentBucketId`), and every other project with favorites
 * is a row in the project list above it. Nothing is hidden and nothing is chosen.
 *
 * Grouping is by the TOP-LEVEL row's own `project_id`; children follow their
 * parent, so a folder's contents never scatter across buckets. Unscoped rows
 * get their own bucket rather than being duplicated into every project's — the
 * old `bookmarkInScope` rule rendered them everywhere precisely because a
 * filter has no third place to put them, and a bucket does.
 */
export function useFavoritesProjectRoots(): {
  roots: BrowseableRoot[];
  /** The bucket to open on mount: always the current project's. */
  currentBucketId: string;
  /** Its name — the bucket itself is not a row until the project holds a bookmark. */
  currentBucketLabel: string;
  /** The rows under a bucket or a folder, synchronously — for a caller that
   *  shows one level at a time instead of expanding rows in place. */
  rowsUnder: (nodeId: string) => Browseable[];
  /**
   * Where a level's "add here" toolbar files, or null when the level cannot
   * receive one — the whole bucket-vs-bookmark question, answered here rather
   * than by the menu matching id prefixes it should not have to know about.
   *
   * A bucket's level IS the real root parent (''), and a new row is stamped
   * with the CURRENT project, so only the current bucket can take one; another
   * project's desk would quietly file into this one, out of view.
   * Ordinary folders file into themselves by id, in every bucket — bucketing
   * follows a row's TOP-LEVEL ancestor, so a favorite added inside another project's folder
   * stays exactly where it was added.
   */
  addParentFor: (levelId: string) => string | null;
} {
  const { roots, favorites, folders, navigableIds, subtreeOf, folderRows } = useFavoritesRoots({
    iconClassName: 'h-4 w-4',
    hideEmptyFolders: true,
  });
  // dataContext, NOT `useProject()`: the menu reads `currentBucketId` ONCE, as
  // the level it opens on. `useProject` resolves the project entity through a
  // fetch, so it is still null on that first render — the menu would then open
  // on the empty id, i.e. the Personal bucket. dataContext already holds the
  // active project synchronously.
  const { project } = useDataContext();
  const currentProjectId = project?.id ?? '';
  const projectsQuery = useMemo(() => new QueryRequest({ type: Project.type }), []);
  // A stable empty list: `= []` here would be a new array on every render until
  // the query lands, rebuilding `roots` each time for whoever keys on them.
  const allProjects = useEntitiesQuery<Project>(projectsQuery).data ?? NO_PROJECTS;
  const { t } = useLingui();

  const built = useMemo(() => {
    const byId = new Map<string, Bookmark>();
    for (const b of [...folders, ...favorites]) if (b.id) byId.set(b.id, b);

    const names = new Map<string, string>();
    for (const p of allProjects) if (p.id) names.set(p.id, p.displayName ?? p.id);

    // Partition the (already sorted) root rows. `roots` node ids ARE bookmark
    // ids, which is what lets the grouping run over the rendered nodes without
    // the adapter having to re-derive them.
    const buckets = new Map<string, Browseable[]>();
    for (const node of roots) {
      const bookmark = byId.get(node.id);
      const key = favoritesBucketId(bookmark?.project_id ?? '');
      const list = buckets.get(key);
      if (list) list.push(node);
      else buckets.set(key, [node]);
    }

    // Unopened leaves per bucket — the badge that makes "there is something new
    // over in that project" visible without entering it. Counted over the
    // bucket's own rows (a folder through `subtreeOf`), so it sums exactly the
    // leaves its folders' badges count.
    const unopenedPerBucket = new Map<string, number>();
    for (const [key, nodes] of buckets) {
      let unopened = 0;
      for (const node of nodes) {
        const b = byId.get(node.id);
        if (!b) continue;
        const leaves = b.bookmark_type === BookmarkType.FAVORITE_FOLDER ? subtreeOf(b.id).leaves : [b];
        for (const leaf of leaves) if (isUnopened(leaf) && navigableIds.has(leaf.id)) unopened++;
      }
      unopenedPerBucket.set(key, unopened);
    }

    const currentBucket = favoritesBucketId(currentProjectId);
    const labelFor = (key: string): string =>
      key === FAVORITES_PERSONAL_BUCKET
        ? t`Personal`
        : names.get(key.slice(FAVORITES_BUCKET_PREFIX.length)) ?? t`Other project`;

    // Resolved at render time from the backend type registry (type-icons rule).
    const ProjectIcon = iconForType(Project.type);
    const asBucket = (key: string, children: Browseable[]): BrowseableRoot => {
      return {
        kind: 'root',
        id: key,
        label: labelFor(key),
        // A project, not a folder: its own registry icon and a header weight,
        // so a bucket never reads as a (possibly empty) folder.
        icon: key === FAVORITES_PERSONAL_BUCKET ? <Star className="h-4 w-4" /> : <ProjectIcon className="h-4 w-4" />,
        rowClassName: 'font-medium text-muted-foreground',
        hasChildren: true,
        listChildren: () => Promise.resolve(children),
        pointer: null,
        selectionKey: key,
        badge: unopenedBadge(unopenedPerBucket.get(key) ?? 0),
        tooltip: (
          <div className="text-xs font-medium">
            {key === currentBucket ? t`${labelFor(key)} — current project` : labelFor(key)}
          </div>
        ),
        // Deep-link auto-expand is a no-op here for the same reason the tree
        // roots are: the menu closes on the first navigation.
        ownsPointer: () => false,
        pathFor: () => Promise.resolve([]),
      };
    };

    // Current project first — it is the one that opens — then the rest by name,
    // and the unscoped desk last.
    const rank = (k: string) => (k === currentBucket ? 0 : k === FAVORITES_PERSONAL_BUCKET ? 2 : 1);
    const ordered = [...buckets].sort(
      ([a], [b]) => rank(a) - rank(b) || labelFor(a).localeCompare(labelFor(b)),
    );

    // Only buckets that HOLD something are rows — an empty project desk read
    // as an empty folder. `currentBucketId` is still always the current
    // project's, existing or not: the menu opens on it either way.
    return {
      roots: ordered.map(([k, children]) => asBucket(k, children)),
      currentBucketId: currentBucket,
      currentBucketLabel: labelFor(currentBucket),
      rowsUnder: (nodeId: string) => buckets.get(nodeId) ?? folderRows(nodeId),
      addParentFor: (levelId: string): string | null => {
        if (levelId === currentBucket) return '';
        if (levelId.startsWith(FAVORITES_BUCKET_PREFIX)) return null;
        return levelId;
      },
    };
  }, [roots, favorites, folders, navigableIds, subtreeOf, folderRows, allProjects, currentProjectId, t]);

  return built;
}
