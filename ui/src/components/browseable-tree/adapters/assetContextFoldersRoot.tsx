import { t } from '@lingui/core/macro';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Download, Folder, FolderPlus, FolderTree, GitBranch, Trash2 } from 'lucide-react';
import { DockPointer } from '@src/navigation/DockPointer';
import apiClient from '@sdk/client';
import { VFSPath, type DependencyState, type ProjectContextDirInfo, type ProjectMenuNode, type TypeId } from '@sdk';
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
import {
  DependencyStateDot,
  dependencySourceIcon,
  dependencyStateLabel,
} from '@src/components/assets/DependencyChips';
import { RagFolderIcon } from '@src/components/browseable-tree/RagFolderIcon';
import { matchContextDir } from '@src/hooks/use-dependency-for-rel';
import { LOCAL_COMPUTE_NODE } from '@src/navigation/asset-doc-types';

/**
 * assetContextFoldersRoot — the Assets navigator's "Dependencies" root.
 *
 * Lists the scoped project's dependencies. A dependency with a local folder
 * (`context_dir_infos`) is a clickable folder row; unlike the Explorer's
 * `contextFoldersRoot` (whose children navigate the Explorer), each row here
 * addresses the Assets body via `DockPointer.forAssetFsFolder(...)` — clicking
 * shows a real file explorer of that folder *inside* the Assets view. A declared
 * dependency with NO folder here (missing, unreachable, optional and not
 * installed) is still listed, as a plain row carrying its state.
 *
 * Mutations stay with the host (URL-first: rows only navigate): the root's
 * toolbar "+" and each row's Remove / Install call back into `useAssetsModel`,
 * which owns the project entity and runs `remove-dependency` / `install-dependency`.
 */
export interface AssetContextFoldersRootDeps {
  /** The project's resolved dependency folders (absolute canonical posix path
   *  + origin kind — "git" rows render with a git icon). */
  dirs: ProjectContextDirInfo[];
  /** Every declared dependency with its state (`GET dependencies`), so the
   *  ones with no local folder are listed too. Empty until it loads — the rows
   *  then fall back to `dirs` alone. */
  dependencies?: DependencyState[];
  /** Compute node whose VFS backs the folders. When present, each context
   *  folder row expands into its real on-disk tree (lazy fs browse). */
  fsTypeId?: TypeId | null;
  /** Stable locator for that node (`@local` locally, UUID remotely). */
  fsLocatorTypeId?: TypeId | null;
  /** "Add dependency" toolbar action (opens the source dialog). */
  onAdd: () => void | Promise<void>;
  /** Per-row remove action, by dependency name; `dir` is its folder, when it has one. */
  onRemove: (name: string, dir: string | null) => void | Promise<void>;
  /** Install an optional dependency that is not installed yet. */
  onInstall?: (name: string) => void | Promise<void>;
  /** Drop handler: a Files-tree row (file or folder) dragged onto a context
   *  folder row is copied into that folder. The host owns the fs mutation. */
  onDropItem?: (item: FsDragItem, dir: string) => void | Promise<void>;
  /** OS drop handler: files/folders dragged in from outside the app are
   *  uploaded into the dependency folder (structure preserved via relPath). */
  onExternalDrop?: (entries: DroppedFileEntry[], dir: string) => void | Promise<void>;
  /** Scoped project id — anchors the git rows' push-dialog conversations. */
  projectId?: string | null;
  /** Server-computed menu nodes keyed by canonical path (see
   *  `useProjectAssetMenu`). When present, each dependency row also lists
   *  the per-type groups found under it and any dependencies of its OWN —
   *  the folder is itself a Project, so the walk recurses. Absent ⇒ rows behave
   *  exactly as before (filesystem browsing only). */
  menuByPath?: Map<string, ProjectMenuNode>;
  /** The mode-filtered type names the menu lists, so nested per-type rows honor
   *  the same view-mode gate as the top-level ones. */
  visibleTypes?: ReadonlySet<string>;
}

/** Stable id for a per-type row nested under a dependency folder. Anchored on the
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
 *  project's OWN dependencies (depth 1, not reached `via` another) can be
 *  removed from here — anything deeper belongs to another project's
 *  `flow.json`. Sourced from the server model rather than a caller flag. */
interface DirRow {
  path: string;
  origin_kind?: string | null;
  typeid?: string | null;
  depth: number;
  /** The declared dependency this folder resolves (state, source, kind). */
  dependency?: DependencyState | null;
}

/** The trailing mark every dependency row carries: a dot coloured by its
 *  state. Only a dot — the sidebar is narrow, and chips there squeezed the
 *  name down to a letter. State, kind and reason are in the row's tooltip. */
function dependencyChips(dep: DependencyState | null | undefined) {
  if (!dep) return null;
  return <DependencyStateDot dependency={dep} />;
}

/** Remove / Install for a dependency the scoped project declares itself. */
function dependencyToolbar(
  dep: DependencyState | null | undefined,
  dir: string | null,
  deps: AssetContextFoldersRootDeps,
) {
  if (!dep || dep.via) return undefined;
  const actions = [];
  // Optional and not here — never installed, or an install that failed (the
  // backend then reports the failure state): Install is the (re)try.
  if (!dep.required && dep.state !== 'ready' && deps.onInstall) {
    const { onInstall } = deps;
    actions.push({
      id: 'install',
      icon: <Download className="h-3 w-3" />,
      label: t`Install dependency`,
      run: () => onInstall(dep.name),
    });
  }
  actions.push({
    id: 'remove',
    icon: <Trash2 className="h-3 w-3" />,
    label: t`Remove dependency`,
    run: () => deps.onRemove(dep.name, dir),
  });
  return actions;
}

/** Tooltip for a dependency row: its state and kind, where it comes from, and
 *  why it isn't ready. */
function dependencyTooltip(dep: DependencyState) {
  const via = dep.via;
  const state = dependencyStateLabel(dep.state);
  return (
    <div className="flex max-w-[320px] flex-col gap-0.5 text-xs">
      <span className="font-medium" data-testid="dependency-tooltip-state">
        {dep.required ? t`${state} · required` : t`${state} · optional`}
      </span>
      <span className="break-all font-mono">{dep.source}</span>
      {via && <span className="text-muted-foreground">{t`via ${via}`}</span>}
      {dep.reason && <span className="text-muted-foreground">{dep.reason}</span>}
    </div>
  );
}

/** Stable id for a dependency row that has no folder here. */
export function assetDependencyNodeId(name: string, via?: string | null): string {
  return `asset-dependency:${via ? `${via}/` : ''}${name}`;
}

/** A declared dependency with no local folder: a leaf that only reports. */
function absentDependencyNode(dep: DependencyState, deps: AssetContextFoldersRootDeps): Browseable {
  const Icon = dependencySourceIcon(dep.source);
  return {
    id: assetDependencyNodeId(dep.name, dep.via),
    kind: 'dependency',
    label: dep.name,
    icon: <Icon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />,
    badge: dependencyChips(dep),
    rowClassName: 'opacity-70 hover:opacity-100',
    tooltip: dependencyTooltip(dep),
    hasChildren: false,
    pointer: null,
    toolbar: dependencyToolbar(dep, null, deps),
  };
}

/** A folder row's inputs from its `context_dir_infos` entry. */
function rowOf(info: ProjectContextDirInfo, dep: DependencyState | null = null): DirRow {
  return { path: info.path, origin_kind: info.origin_kind, typeid: info.typeid, depth: info.via ? 2 : 1, dependency: dep };
}

/** The folder a dependency resolved to, matched by name (and the dependency
 *  that declared it, for a transitive one). */
function infoFor(dep: DependencyState, dirs: ProjectContextDirInfo[]): ProjectContextDirInfo | undefined {
  return dirs.find((d) => !!d.dependency && d.dependency === dep.name && (d.via || '') === (dep.via || ''));
}

/** Every row the root lists: each declared dependency (with its folder when it
 *  has one), then any folder no declared dependency claims (a legacy link, or
 *  the states not loaded yet). */
function dependencyRows(deps: AssetContextFoldersRootDeps, locatorTypeId: TypeId): Browseable[] {
  const { dirs, dependencies = [] } = deps;
  const claimed = new Set<string>();
  const rows: Browseable[] = [];
  for (const dep of dependencies) {
    const info = infoFor(dep, dirs);
    if (info) {
      claimed.add(info.path);
      rows.push(dirNode(rowOf(info, dep), deps, locatorTypeId));
    } else {
      rows.push(absentDependencyNode(dep, deps));
    }
  }
  for (const info of dirs) {
    if (!claimed.has(info.path)) rows.push(dirNode(rowOf(info), deps, locatorTypeId));
  }
  return rows;
}

function dirNode(row: DirRow, deps: AssetContextFoldersRootDeps, locatorTypeId: TypeId): Browseable {
  const { fsTypeId, onDropItem, onExternalDrop, projectId, menuByPath } = deps;
  const dep = row.dependency;
  const dir = row.path;
  const isGit = row.origin_kind === 'git';
  const rel = normalizeRel(dir);
  // With a compute node the row is a real expandable fs folder (lazy browse,
  // same cache as the body's file manager); without one it stays a leaf.
  // Its whole subtree accepts drops, each folder bound to its own path.
  const fsNode = fsTypeId
    ? assetsFsFolderNode(fsTypeId, rel, undefined, subfolderDrop(onDropItem, onExternalDrop), locatorTypeId)
    : null;
  // Menu rows for this folder: its per-type groups, then the dependencies it
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
    // always-visible badge; renders nothing while the repo is clean. Every
    // declared dependency also shows its state and kind.
    badge:
      dep || (isGit && fsTypeId) ? (
        <span className="flex items-center gap-1">
          {dependencyChips(dep)}
          {isGit && fsTypeId && (
            <ContextFolderGitBadge
              workdir={`/${rel}`}
              computeNodeId={fsTypeId.id}
              folderName={basename(rel) || rel}
              folderTypeId={row.typeid || null}
              projectId={projectId}
            />
          )}
        </span>
      ) : undefined,
    tooltip: dep ? dependencyTooltip(dep) : undefined,
    pointer: DockPointer.forAssetFs(VFSPath.fromTypeId(locatorTypeId, rel)),
    canDrop: onDropItem ? (data) => canDropIntoDir(dir, data) : undefined,
    onDrop: onDropItem
      ? async (data) => {
          if (!isFsDragItem(data) || !canDropIntoDir(dir, data)) return;
          await onDropItem(data, dir);
        }
      : undefined,
    onExternalFilesDrop: onExternalDrop ? (entries) => onExternalDrop(entries, dir) : undefined,
    // Only a dependency the scoped project declares itself can be removed
    // here; a legacy link with no dependency name has nothing to remove.
    toolbar: row.depth === 1 ? dependencyToolbar(dep, dir, deps) : undefined,
  };
}

export function assetContextFoldersRoot(deps: AssetContextFoldersRootDeps): BrowseableRoot {
  const { dirs, dependencies = [], fsTypeId, onAdd } = deps;
  const locatorTypeId = deps.fsLocatorTypeId ?? LOCAL_COMPUTE_NODE;
  const root: BrowseableRoot = {
    id: ASSET_CONTEXT_FOLDERS_ROOT_ID,
    kind: 'root',
    label: i18n._(msg`Dependencies`),
    icon: <FolderTree className="h-4 w-4 flex-shrink-0 text-muted-foreground" />,
    hasChildren: dirs.length > 0 || dependencies.length > 0,
    pointer: null,
    listChildren: (): Promise<Browseable[]> => Promise.resolve(dependencyRows(deps, locatorTypeId)),
    toolbar: [
      {
        id: 'add',
        icon: <FolderPlus className="h-3.5 w-3.5" />,
        label: t`Add dependency`,
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
      const dep = dependencies.find((d) => d.name === match.dependency && (d.via || '') === (match.via || ''));
      const chain: Browseable[] = [root, dirNode(rowOf(match, dep ?? null), deps, locatorTypeId)];
      // Deep-link below the dependency dir: chain the intermediate fs folder
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
