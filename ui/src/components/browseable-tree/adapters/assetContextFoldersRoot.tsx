import { t } from '@lingui/core/macro';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Folder, FolderPlus, FolderTree, GitBranch, Trash2 } from 'lucide-react';
import { DockPointer } from '@src/navigation/DockPointer';
import apiClient from '@sdk/client';
import { VFSPath, type ProjectContextDirInfo, type ProjectMenuNode, type TypeId } from '@sdk';
import { CountChip } from '@src/components/browseable-tree/CountChip';
import { iconForType, labelForType } from '@src/components/graph-view/icons/iconRegistry';
import type {
  Browseable,
  BrowseableDragData,
  BrowseableRoot,
  DroppedFileEntry,
} from '@src/components/browseable-tree/types';
import {
  assetsFsFolderNode,
  basename,
  fsDragEntries,
  isFsDragItem,
  normalizeRel,
  type FsDragItem,
  type FsFolderDrop,
} from './fsFolderRoot';
import { ContextFolderGitBadge } from '@src/components/assets/ContextFolderGitBadge';
import { RagFolderIcon } from '@src/components/browseable-tree/RagFolderIcon';
import { matchContextDir } from '@src/hooks/use-context-folder-for-rel';
import { LOCAL_COMPUTE_NODE } from '@src/navigation/asset-doc-types';

/**
 * assetContextFoldersRoot — the Assets navigator's "Context folders" root.
 *
 * Lists the scoped project's `include_dirs` as clickable folder rows. Unlike the
 * Explorer's `contextFoldersRoot` (whose children navigate the Explorer), each
 * row here addresses the Assets body via `DockPointer.forAssetFsFolder(...)` —
 * clicking shows a real file explorer of that folder *inside* the Assets view.
 *
 * Mutations stay with the host (URL-first: rows only navigate): the root's
 * toolbar "+" and each row's "×" call back into `useAssetsModel`, which owns the
 * project entity and runs `add-context-dir` / `remove-context-dir`.
 */
export interface AssetContextFoldersRootDeps {
  /** The project's context folders (absolute canonical posix path + origin
   *  kind — "git" rows render with a git icon). */
  dirs: ProjectContextDirInfo[];
  /** Compute node whose VFS backs the folders. When present, each context
   *  folder row expands into its real on-disk tree (lazy fs browse). */
  fsTypeId?: TypeId | null;
  /** Stable locator for that node (`@local` locally, UUID remotely). */
  fsLocatorTypeId?: TypeId | null;
  /** "Add context folder" toolbar action (native folder picker → add). */
  onAdd: () => void | Promise<void>;
  /** Per-row remove action. */
  onRemove: (dir: string) => void | Promise<void>;
  /** Drop handler: a Files-tree row (file or folder) dragged onto a context
   *  folder row is copied into that folder. The host owns the fs mutation. */
  onDropItem?: (item: FsDragItem, dir: string) => void | Promise<void>;
  /** OS drop handler: files/folders dragged in from outside the app are
   *  uploaded into the context folder (structure preserved via relPath). */
  onExternalDrop?: (entries: DroppedFileEntry[], dir: string) => void | Promise<void>;
  /** Scoped project id — anchors the git rows' push-dialog conversations. */
  projectId?: string | null;
  /** Server-computed menu nodes keyed by canonical path (see
   *  `useProjectAssetMenu`). When present, each context-folder row also lists
   *  the per-type groups found under it and any context folders of its OWN —
   *  the folder is itself a Project, so the walk recurses. Absent ⇒ rows behave
   *  exactly as before (filesystem browsing only). */
  menuByPath?: Map<string, ProjectMenuNode>;
  /** The mode-filtered type names the menu lists, so nested per-type rows honor
   *  the same view-mode gate as the top-level ones. */
  visibleTypes?: ReadonlySet<string>;
}

/** Stable id for a per-type row nested under a context folder. Anchored on the
 *  owning folder so the same type under two folders never collides. */
export function contextTypeNodeId(dir: string, typeName: string): string {
  return `${assetContextFolderNodeId(dir)}/t:${typeName}`;
}

interface ByPathEntity {
  id: string;
  type: string;
  name: string;
  asset_ref: string;
  remote?: boolean;
}

/**
 * Children of a nested per-type row: the entities of that type under that
 * folder, fetched lazily on expand.
 *
 * Leaves stay lazy on purpose — the menu payload carries structure and counts,
 * never the assets themselves. `assets/by-path` is the existing folder-prefix
 * lookup (a SQL lex-range over `asset_ref`), so this needs no new route.
 */
function typeRowChildren(dir: string, typeName: string, selfId: string) {
  return async (): Promise<Browseable[]> => {
    const params = new URLSearchParams({ folder: dir, record_type: typeName, limit: '200' });
    let entities: ByPathEntity[] = [];
    try {
      const data = (await apiClient.get(`/assets/by-path?${params.toString()}`)) as {
        entities?: ByPathEntity[];
      } | null;
      entities = data?.entities ?? [];
    } catch (err) {
      console.error('[assetContextFoldersRoot] by-path lookup failed', err);
      return [];
    }
    const Icon = iconForType(typeName);
    return entities.map((e) => ({
      id: `${selfId}/a:${e.asset_ref}`,
      kind: 'asset',
      label: e.name || basename(normalizeRel(e.asset_ref)) || e.asset_ref,
      icon: <Icon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />,
      hasChildren: false as const,
      pointer: DockPointer.forAssetEditor(typeName, e.asset_ref),
      // The typeid form, so a typeid-addressed URL still selects this row.
      selectionKey: `${e.type}-${e.id}`,
    }));
  };
}

/** The per-type rows for one menu node: type, accumulated count, lazy entities.
 *
 *  `visibleTypes` is the SAME mode-filtered set the top-level type rows are
 *  built from, so a type hidden in the current view mode (e.g. a dev-only one
 *  under Standard) can't reappear here. The menu payload carries no view-mode
 *  tier of its own precisely so this decision has one home. */
function typeRows(dir: string, node: ProjectMenuNode | undefined, visibleTypes?: ReadonlySet<string>): Browseable[] {
  if (!node) return [];
  return (node.groups ?? [])
    .filter((g) => g.count > 0 && (!visibleTypes || visibleTypes.has(g.type_name)))
    .map((g) => {
      const selfId = contextTypeNodeId(dir, g.type_name);
      const Icon = iconForType(g.type_name);
      return {
        id: selfId,
        kind: 'asset-type',
        label: labelForType(g.type_name),
        icon: <Icon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />,
        // The count is accumulated over the subtree; `own_count` is what lives
        // in THIS folder, which is what expanding actually lists.
        badge: (
          <CountChip
            count={g.count}
            title={g.count === g.own_count ? undefined : `${g.own_count} here, ${g.count} including subfolders`}
          />
        ),
        hasChildren: g.own_count > 0,
        listChildren: typeRowChildren(dir, g.type_name, selfId),
        pointer: null,
      } satisfies Browseable;
    });
}

/** The root's node id — exported so a mutation that changes the folder LIST
 *  (add / remove) can invalidate its cached children. The tree caches
 *  `listChildren` per node id, so rebuilding `roots` alone leaves an expanded
 *  root showing the rows it already fetched. */
export const ASSET_CONTEXT_FOLDERS_ROOT_ID = 'asset-context-folders-root';

export function assetContextFolderNodeId(dir: string): string {
  return `asset-context-folder:${normalizeRel(dir) || '/'}`;
}

function parentRel(rel: string): string {
  const idx = rel.lastIndexOf('/');
  return idx >= 0 ? rel.slice(0, idx) : '';
}

function canDropIntoDir(dir: string, data: BrowseableDragData): boolean {
  if (!isFsDragItem(data)) return false;
  const dest = normalizeRel(dir);
  // Every dragged entry (one row, or a multi-selection) must be droppable.
  return fsDragEntries(data).every(({ relPath, isDir }) => {
    const src = normalizeRel(relPath);
    if (!src) return false;
    // No-op / cycle guards: already directly inside the target, or dropping a
    // folder into itself or its own descendant.
    if (parentRel(src) === dest) return false;
    if (isDir && (src === dest || dest.startsWith(`${src}/`))) return false;
    return true;
  });
}

/** Drop handlers for any folder INSIDE a context dir, bound to that folder's
 *  own path — so a drop lands in the exact subfolder it was released on. */
function subfolderDrop(
  onDropItem: AssetContextFoldersRootDeps['onDropItem'],
  onExternalDrop: AssetContextFoldersRootDeps['onExternalDrop'],
): ((rel: string) => FsFolderDrop) | undefined {
  if (!onDropItem && !onExternalDrop) return undefined;
  return (rel: string) => {
    const abs = `/${normalizeRel(rel)}`;
    return {
      canDrop: onDropItem ? (data: BrowseableDragData) => canDropIntoDir(abs, data) : undefined,
      onDrop: onDropItem
        ? async (data: BrowseableDragData) => {
            if (!isFsDragItem(data) || !canDropIntoDir(abs, data)) return;
            await onDropItem(data, abs);
          }
        : undefined,
      onExternalFilesDrop: onExternalDrop ? (entries: DroppedFileEntry[]) => onExternalDrop(entries, abs) : undefined,
    };
  };
}

/** A folder row's inputs. `depth` is what decides removability: only the scoped
 *  project's OWN links (depth 1) can be unlinked from here — anything deeper
 *  belongs to another project, so `remove-context-dir` on the scoped project
 *  would be a no-op. Sourced from the server model rather than a caller flag. */
interface DirRow {
  path: string;
  origin_kind?: string | null;
  typeid?: string | null;
  depth: number;
}

function dirNode(row: DirRow, deps: AssetContextFoldersRootDeps, locatorTypeId: TypeId): Browseable {
  const { fsTypeId, onRemove, onDropItem, onExternalDrop, projectId, menuByPath } = deps;
  const dir = row.path;
  const isGit = row.origin_kind === 'git';
  const rel = normalizeRel(dir);
  // With a compute node the row is a real expandable fs folder (lazy browse,
  // same cache as the body's file manager); without one it stays a leaf.
  // Its whole subtree accepts drops, each folder bound to its own path.
  const fsNode = fsTypeId
    ? assetsFsFolderNode(fsTypeId, rel, undefined, subfolderDrop(onDropItem, onExternalDrop), locatorTypeId)
    : null;
  // Menu rows for this folder: its per-type groups, then the context folders it
  // owns in turn (this folder is itself a Project). Both come pre-materialized
  // from one server call, so they resolve synchronously; the filesystem entries
  // below them stay lazy, exactly as before.
  const node = menuByPath?.get(dir);
  const menuRows: Browseable[] = [
    ...typeRows(dir, node, deps.visibleTypes),
    ...(node?.children ?? []).map((child) =>
      dirNode(
        { path: child.path, origin_kind: child.origin_kind, typeid: child.folder_typeid, depth: child.depth },
        deps,
        locatorTypeId,
      ),
    ),
  ];
  const fsChildren = fsNode?.listChildren;
  return {
    ...fsNode,
    id: assetContextFolderNodeId(dir),
    kind: 'folder',
    label: basename(rel) || rel,
    icon: <RagFolderIcon Base={isGit ? GitBranch : Folder} path={`/${rel}`} />,
    hasChildren: !!fsNode || menuRows.length > 0,
    listChildren: menuRows.length
      ? async (opts) => [...menuRows, ...(fsChildren ? await fsChildren(opts) : [])]
      : fsChildren,
    // Git rows carry the status-bar pill pair (changes count + Push) as an
    // always-visible badge; renders nothing while the repo is clean.
    badge:
      isGit && fsTypeId ? (
        <ContextFolderGitBadge
          workdir={`/${rel}`}
          computeNodeId={fsTypeId.id}
          folderName={basename(rel) || rel}
          folderTypeId={row.typeid || null}
          projectId={projectId}
        />
      ) : undefined,
    pointer: DockPointer.forAssetFs(VFSPath.fromTypeId(locatorTypeId, rel)),
    canDrop: onDropItem ? (data) => canDropIntoDir(dir, data) : undefined,
    onDrop: onDropItem
      ? async (data) => {
          if (!isFsDragItem(data) || !canDropIntoDir(dir, data)) return;
          await onDropItem(data, dir);
        }
      : undefined,
    onExternalFilesDrop: onExternalDrop ? (entries) => onExternalDrop(entries, dir) : undefined,
    toolbar:
      row.depth === 1
        ? [
            {
              id: 'remove',
              icon: <Trash2 className="h-3 w-3" />,
              label: t`Remove context folder`,
              run: () => onRemove(dir),
            },
          ]
        : undefined,
  };
}

export function assetContextFoldersRoot(deps: AssetContextFoldersRootDeps): BrowseableRoot {
  const { dirs, fsTypeId, onAdd } = deps;
  const locatorTypeId = deps.fsLocatorTypeId ?? LOCAL_COMPUTE_NODE;
  const root: BrowseableRoot = {
    id: ASSET_CONTEXT_FOLDERS_ROOT_ID,
    kind: 'root',
    label: i18n._(msg`Context folders`),
    icon: <FolderTree className="h-4 w-4 flex-shrink-0 text-muted-foreground" />,
    hasChildren: dirs.length > 0,
    pointer: null,
    listChildren: (): Promise<Browseable[]> =>
      Promise.resolve(dirs.map((info) => dirNode({ ...info, depth: 1 }, deps, locatorTypeId))),
    toolbar: [
      {
        id: 'add',
        icon: <FolderPlus className="h-3.5 w-3.5" />,
        label: t`Add context folder`,
        run: onAdd,
      },
    ],
    ownsPointer: (pointer) => {
      const resource = pointer.resourceVfsPath;
      return !!resource?.typeId?.equals(locatorTypeId) && !!matchContextDir(dirs, normalizeRel(resource.entitySubPath));
    },
    pathFor: (p) => {
      const resource = p.resourceVfsPath;
      const rel = resource?.typeId?.equals(locatorTypeId) ? normalizeRel(resource.entitySubPath) : '';
      const match = matchContextDir(dirs, rel);
      if (!match) return Promise.resolve([root]);
      const chain: Browseable[] = [root, dirNode({ ...match, depth: 1 }, deps, locatorTypeId)];
      // Deep-link below the context dir: chain the intermediate fs folder
      // nodes (same ids listChildren produces) so the tree auto-expands.
      if (fsTypeId) {
        const dirRel = normalizeRel(match.path);
        const extra = rel === dirRel ? '' : rel.slice(dirRel.length).replace(/^\/+/, '');
        let cur = dirRel;
        for (const seg of extra ? extra.split('/') : []) {
          cur = `${cur}/${seg}`;
          chain.push(
            assetsFsFolderNode(fsTypeId, cur, seg, subfolderDrop(deps.onDropItem, deps.onExternalDrop), locatorTypeId),
          );
        }
      }
      return Promise.resolve(chain);
    },
  };
  return root;
}
