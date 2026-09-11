import { BookmarkType, Project, QueryRequest, type Bookmark } from '@sdk';
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
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useContext as useDataContext } from '@sdk/react/hooks';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { lucideByName } from '@src/lib/lucide-by-name';
import { formatTimeAgo } from '@src/utils/format-time-ago';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  Bookmark as BookmarkIcon,
  Folder,
  FolderOpen,
  Star,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
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
    // render it (useFavorites.reapDead also hard-deletes these when the slider
    // opens; this keeps them off-screen immediately, without waiting on the
    // reap's refetch). Folders carry no target ref, so they bypass the check.
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
            run: async () => {
              await removeFavorite(b);
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

    // The visible LEAF favorites under a folder, descending through nested
    // subfolders — so `Auto` sees everything filed beneath it while each
    // `Auto/<type>` sees only its own. Cycle-guarded (a malformed parent_id
    // loop can't hang render). Callers count what they need off the result.
    const leavesUnder = (folderId: string, seen: Set<string> = new Set()): Bookmark[] => {
      if (!folderId || seen.has(folderId)) return [];
      seen.add(folderId);
      return childrenOf(folderId)
        .filter(isVisible)
        .flatMap((k) =>
          k.bookmark_type === BookmarkType.FAVORITE_FOLDER ? leavesUnder(k.id ?? '', seen) : [k],
        );
    };

    const asFolder = (folder: Bookmark): Browseable => {
      const title = folder.name || folder.title || folder.displayName;
      const allChildren = folder.id ? childrenOf(folder.id) : [];
      const children = allChildren.filter(isVisible);
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
        // How many items beneath have never been opened.
        badge: unopenedBadge(unopened),
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
            run: async () => {
              await deleteFolder(folder);
              refreshFolder(folder.parent_id);
            },
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
      roots: sortContainer([...visibleFolders, ...visibleRootFavorites]).map((b) =>
        b.bookmark_type === BookmarkType.FAVORITE_FOLDER ? asFolder(b) : asLeaf(b),
      ),
      favorites,
      folders,
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

/**
 * The favorites tree as it is actually stored: ONE GLOBAL desk, grouped by the
 * project each top-level row belongs to.
 *
 * This replaces the scope-filter header the bookmarks menu used to carry. A
 * filter answers "which project am I looking at?" with a mode you first have to
 * set; the tree answers it with structure — the current project's bucket is
 * expanded on open (`currentBucketId`, fed to the tree's `defaultExpandedIds`),
 * and every other project with favorites is one row away, entered by hovering
 * it exactly like any other folder. Nothing is hidden and nothing is chosen.
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
  /**
   * Where a level's "add here" toolbar files, or null when the level cannot
   * receive one — the whole bucket-vs-bookmark question, answered here rather
   * than by the menu matching id prefixes it should not have to know about.
   *
   * A bucket's level IS the real root parent (''), and a new row is stamped
   * with the CURRENT project, so only the current bucket can take one; another
   * project's desk would quietly file into this one, out of view. The tree root
   * is the project LIST and owns no bookmarks at all. Ordinary folders file
   * into themselves by id, in every bucket — bucketing follows a row's
   * TOP-LEVEL ancestor, so a favorite added inside another project's folder
   * stays exactly where it was added.
   */
  addParentFor: (levelId: string) => string | null;
} {
  const { roots, favorites, folders } = useFavoritesRoots({ iconClassName: 'h-4 w-4', hideEmptyFolders: true });
  // dataContext, NOT `useProject()`: the tree's `defaultExpandedIds` is read
  // ONCE, when `useBrowseableTree` seeds its state on mount. `useProject`
  // resolves the project entity through a fetch, so it is still null on that
  // first render — the seed then lands on the empty id, i.e. the Personal
  // bucket, and the current project opens closed. dataContext already holds
  // the active project synchronously.
  const { project } = useDataContext();
  const currentProjectId = project?.id ?? '';
  const projectsQuery = useMemo(() => new QueryRequest({ type: Project.type }), []);
  const { data: allProjects = [] } = useEntitiesQuery<Project>(projectsQuery);
  const { t } = useLingui();

  const built = useMemo(() => {
    const byId = new Map<string, Bookmark>();
    for (const b of [...folders, ...favorites]) if (b.id) byId.set(b.id, b);

    // Which bucket a row belongs to: its TOP-MOST ancestor's project_id, so a
    // leaf filed under `Auto / Documents` buckets with `Auto`. Cycle-guarded,
    // and memoized across the walk — siblings share an ancestor chain, so
    // resolving it per leaf would re-walk the same parents once per row.
    const bucketCache = new Map<string, string>();
    const bucketOf = (b: Bookmark): string => {
      const chain: string[] = [];
      let cur: Bookmark | undefined = b;
      let bucket: string | undefined;
      while (cur) {
        const cached = cur.id ? bucketCache.get(cur.id) : undefined;
        if (cached) {
          bucket = cached;
          break;
        }
        if (cur.id) chain.push(cur.id);
        // Annotated, not inferred: `cur` is reassigned from `parent` at the
        // foot of the loop, so inferring `parent` from `cur.parent_id` makes
        // each type depend on the other and TS gives up with an implicit any.
        const parent: Bookmark | undefined = cur.parent_id ? byId.get(cur.parent_id) : undefined;
        // A cycle re-enters an id already on this chain; stop and bucket by the
        // row we are standing on rather than looping forever.
        if (!parent || (parent.id && chain.includes(parent.id))) {
          bucket = favoritesBucketId(cur.project_id ?? '');
          break;
        }
        cur = parent;
      }
      const resolved = bucket ?? FAVORITES_PERSONAL_BUCKET;
      for (const id of chain) bucketCache.set(id, resolved);
      return resolved;
    };

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
    // over in that project" visible without entering it.
    const unopenedPerBucket = new Map<string, number>();
    for (const f of favorites) {
      if (!isUnopened(f) || !canNavigateFavorite(f)) continue;
      const key = bucketOf(f);
      unopenedPerBucket.set(key, (unopenedPerBucket.get(key) ?? 0) + 1);
    }

    const currentBucket = favoritesBucketId(currentProjectId);
    const labelFor = (key: string): string =>
      key === FAVORITES_PERSONAL_BUCKET
        ? t`Personal`
        : names.get(key.slice(FAVORITES_BUCKET_PREFIX.length)) ?? t`Other project`;

    const asBucket = (key: string, children: Browseable[]): BrowseableRoot => {
      return {
        kind: 'root',
        id: key,
        label: labelFor(key),
        icon:
          key === FAVORITES_PERSONAL_BUCKET ? (
            <Star className="h-4 w-4" />
          ) : (
            <FolderOpen className="h-4 w-4" />
          ),
        // The current project can receive its first bookmark even when empty.
        hasChildren: children.length > 0 || key === currentBucket,
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
    if (!buckets.has(currentBucket)) buckets.set(currentBucket, []);
    const keys = [...buckets.keys()].sort(
      (a, b) => rank(a) - rank(b) || labelFor(a).localeCompare(labelFor(b)),
    );

    // Always the current project's bucket, even before the bookmark query has
    // landed and the bucket exists: `useBrowseableTree` seeds its expanded set
    // ONCE, on the first render, and the first render has no rows yet.
    // Narrowing this to buckets that already exist made the seed empty every
    // time, and the menu opened fully collapsed. Expanding an id that is not
    // on screen yet is harmless — it takes effect when the row arrives.
    return {
      roots: keys.map((k) => asBucket(k, buckets.get(k) ?? [])),
      currentBucketId: currentBucket,
      addParentFor: (levelId: string): string | null => {
        if (levelId === currentBucket) return '';
        if (levelId === '' || levelId.startsWith(FAVORITES_BUCKET_PREFIX)) return null;
        return levelId;
      },
      // Child-id signature per bucket — the input to the reload below. Kept
      // inside this object rather than returned: it is the effect's business,
      // not the caller's (see the narrowed return at the end of the hook).
      signatures: new Map(keys.map((k) => [k, (buckets.get(k) ?? []).map((n) => n.id).join('|')])),
    };
  }, [roots, favorites, folders, allProjects, currentProjectId, t]);

  // A bucket is expanded on mount (that is the whole point of
  // `currentBucketId`), and the tree CACHES an expanded node's children the
  // first time it asks for them. On a cold load it asks before the bookmark
  // query has landed, caches the empty list, and the project's desk then reads
  // as empty however many rows arrive a moment later — the roots prop only
  // refreshes rows at the TOP level. Tell the tree to reload a bucket whenever
  // its membership actually changes; `refreshNode` is the seam the folder rows
  // already use for exactly this.
  const lastSignatures = useRef(new Map<string, string>());
  useEffect(() => {
    for (const [id, signature] of built.signatures) {
      if (lastSignatures.current.get(id) === signature) continue;
      const first = !lastSignatures.current.has(id);
      lastSignatures.current.set(id, signature);
      // A bucket seen for the first time has nothing cached to invalidate.
      if (!first) refreshNode(id);
    }
  }, [built.signatures]);

  return useMemo(
    () => ({ roots: built.roots, currentBucketId: built.currentBucketId, addParentFor: built.addParentFor }),
    [built],
  );
}
