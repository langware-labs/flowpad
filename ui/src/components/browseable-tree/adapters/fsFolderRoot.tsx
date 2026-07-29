import { FSItem, TypeId, VFSPath, fsStore } from '@sdk';
import { File, Folder } from 'lucide-react';
import type { ReactNode } from 'react';
import { DockPointer, normalizeRel } from '@src/navigation/DockPointer';
import { dockPointerForFile } from '@src/navigation/local-file-pointer';
import type { ScopeFilter } from '@src/lib/scope-filter';
import type { Browseable, BrowseableDragData, BrowseableRoot } from '@src/components/browseable-tree/types';
import { LOCAL_COMPUTE_NODE } from '@src/navigation/asset-doc-types';

/**
 * fsFolderRoot — a real-filesystem browseable root.
 *
 * Structurally mirrors `markdownFolderRoot`, but instead of a one-shot
 * gitignore-aware walk it lists **per folder, lazily** via the proven
 * SimpleFileManager path (`fsStore.listDirectory`). One root anchors the tree at
 * a single VFS folder. By default every node addresses the Explorer by a
 * vfs-path `DockPointer.forExplorer(...)` carrying the active scope (the
 * Explorer left menu); a host can swap only the destination route via
 * `pointerForVfs`. Resource ownership and deep-link resolution always use the
 * canonical VFS identity carried by the DockPointer.
 */
export interface FsFolderRootDeps {
  /** Live compute_node TypeId whose VFS we browse (never the stale URL id). */
  typeId: TypeId;
  /** Entity-relative anchor (no leading slash); '' = VFS root `/`. */
  anchorRelPath: string;
  /** Active scope — stamped onto every node pointer so clicks keep the filter. */
  scope: ScopeFilter;
  /** Root row label (e.g. "Computer" / "Home" / the project name). */
  label: string;
  /** Root row icon (scope-specific). */
  rootIcon?: ReactNode;
  /** Project mount (entity-relative) — only used to remap a `project`-typed
   *  deep-link pointer back onto the compute-node VFS in `pathFor`. */
  projectRootPath?: string | null;
  /** Stable locator placed in URLs. Local files use `compute_node-@local`
   *  even when I/O uses a live UUID; remote nodes keep their UUID. */
  locatorTypeId?: TypeId;
  /** Route-specific destination builder. It receives the complete canonical
   *  VFS identity, never a competing relative-path serialization. */
  pointerForVfs?: (path: VFSPath) => DockPointer;
  /** Destination override for FILE rows only — see `FsNodeCtx.filePointerFor`. */
  filePointerForVfs?: (path: VFSPath) => DockPointer;
  /** When true, file/folder rows carry an `FsDragItem` drag payload so drop
   *  targets (e.g. the Assets context-folder rows) can accept them. */
  draggable?: boolean;
}

/** One filesystem entry inside a (possibly multi-item) drag. */
export interface FsDragEntry {
  relPath: string;
  isDir: boolean;
  label: string;
}

/** Drag payload for a real-filesystem row (file or folder), emitted when the
 *  root is built with `draggable`. `relPath` is entity-relative (no leading
 *  slash) on the root's compute-node TypeId. */
export interface FsDragItem extends BrowseableDragData {
  kind: 'fs-item';
  relPath: string;
  isDir: boolean;
  /** All dragged entries when a multi-selection is dragged (includes the
   *  primary row); absent for a single-item drag. */
  items?: FsDragEntry[];
}

export function isFsDragItem(data: BrowseableDragData): data is FsDragItem {
  return data.kind === 'fs-item' && typeof data.relPath === 'string' && typeof data.isDir === 'boolean';
}

/** Normalize a drag payload to its entry list (multi-drag or single row). */
export function fsDragEntries(data: FsDragItem): FsDragEntry[] {
  return data.items?.length ? data.items : [{ relPath: data.relPath, isDir: data.isDir, label: data.label }];
}

// Re-exported so browse-side consumers keep one canonical rel-path form; the
// definition lives with the `fs/` pointer grammar (DockPointer).
export { normalizeRel };

function toFsPath(rel: string): string {
  const r = normalizeRel(rel);
  return r ? `/${r}` : '/';
}

export function basename(rel: string): string {
  const r = normalizeRel(rel);
  const idx = r.lastIndexOf('/');
  return idx >= 0 ? r.slice(idx + 1) : r;
}

function joinRel(parent: string, sub: string): string {
  const p = normalizeRel(parent);
  const s = normalizeRel(sub);
  if (!p) return s;
  if (!s) return p;
  return `${p}/${s}`;
}

/** A path segment that looks like a file (has an extension) — used to trim a
 *  deep-link file pointer down to its parent dir for tree expansion. */
function looksLikeFile(seg: string): boolean {
  return seg.includes('.');
}

/** Root node id — anchor embedded so a scope switch (new anchor) invalidates the
 *  cached children, the same trick markdown's `filterSig` uses. */
export function fsRootNodeId(typeId: TypeId, anchorRel: string): string {
  return `fs-root:${typeId.toString()}:${normalizeRel(anchorRel) || '/'}`;
}

/** Folder node id — keyed by the live typeId + entity-relative path so a
 *  `pathFor` chain node matches the same node from its parent's `listChildren`. */
export function fsFolderNodeId(typeId: TypeId, absRel: string): string {
  return `fs-folder:${typeId.toString()}:${normalizeRel(absRel) || '/'}`;
}

/** Drop capabilities a folder node can expose, resolved per rel path. */
export type FsFolderDrop = Pick<Browseable, 'canDrop' | 'onDrop' | 'onExternalFilesDrop'>;

/** Per-root node context: which VFS the rows list, how they address the body
 *  (pointer grammar), and whether they can be dragged. One ctx per root keeps
 *  the recursive node builders free of per-variant branching. */
interface FsNodeCtx {
  /** Live identity used only for fs I/O and cache keys. */
  typeId: TypeId;
  /** Stable identity used in locators and equality. */
  locatorTypeId: TypeId;
  pointerFor: (path: VFSPath) => DockPointer;
  /** Pointer a FILE row navigates to, when it differs from the folder grammar.
   *  The Explorer leaves this unset: its body trims a file path down to the
   *  containing directory, so a file leaf just lands the table on that folder.
   *  The Assets `fs/` body has no such trim (a file path lists as an EMPTY
   *  folder), so its roots pass `fsFileViewerPointerForVfs` here and a file leaf opens
   *  the file in its viewer instead. */
  filePointerFor?: (path: VFSPath) => DockPointer;
  draggable: boolean;
  /** When present, EVERY folder node in the subtree becomes a drop target —
   *  the factory binds the handlers to that folder's rel path (e.g. copy
   *  dropped rows into that exact subfolder). */
  folderDrop?: (rel: string) => FsFolderDrop;
}

/** The "open this file" pointer for an fs row: the row's VFS identity put
 *  through `dockPointerForFile` — the same extension dispatch (markdown → the
 *  markdown editor, everything else → the code editor) the file manager's
 *  double-click uses, so the tree and the table open a file identically. */
export function fsFileViewerPointerForVfs(path: VFSPath): DockPointer {
  return dockPointerForFile(path.absVfsPath);
}

function explorerCtx(typeId: TypeId, scope: ScopeFilter, locatorTypeId: TypeId = typeId): FsNodeCtx {
  return {
    typeId,
    locatorTypeId,
    pointerFor: (path) => DockPointer.forExplorer(path.absVfsPath).withScopeFilter(scope),
    draggable: false,
  };
}

function vfsForRel(ctx: FsNodeCtx, rel: string): VFSPath {
  return VFSPath.fromTypeId(ctx.locatorTypeId, normalizeRel(rel));
}

function dragDataFor(ctx: FsNodeCtx, id: string, rel: string, label: string, isDir: boolean): FsDragItem | undefined {
  if (!ctx.draggable) return undefined;
  return { kind: 'fs-item', id, label, relPath: normalizeRel(rel), isDir };
}

function fileNode(ctx: FsNodeCtx, rel: string, label: string): Browseable {
  const id = `fs-file:${ctx.typeId.toString()}:${normalizeRel(rel)}`;
  return {
    id,
    kind: 'file',
    label,
    icon: <File className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />,
    hasChildren: false,
    pointer: (ctx.filePointerFor ?? ctx.pointerFor)(vfsForRel(ctx, rel)),
    dragData: dragDataFor(ctx, id, rel, label, false),
  };
}

function folderNode(ctx: FsNodeCtx, rel: string, label: string): Browseable {
  const id = fsFolderNodeId(ctx.typeId, rel);
  return {
    id,
    kind: 'folder',
    label,
    icon: <Folder className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />,
    hasChildren: true,
    pointer: ctx.pointerFor(vfsForRel(ctx, rel)),
    listChildren: (opts) => listChildrenAt(ctx, rel, opts),
    dragData: dragDataFor(ctx, id, rel, label, true),
    ...(ctx.folderDrop ? ctx.folderDrop(rel) : {}),
  };
}

/** Public factory: a browseable folder node addressing an absolute compute-node
 *  path (leading slash stripped to the entity-relative form the VFS uses). Used
 *  by the Explorer's `context_folders` grouping root, which lists project
 *  `include_dirs` that may live anywhere on the compute node's VFS. */
export function fsFolderNode(
  typeId: TypeId,
  scope: ScopeFilter,
  absRel: string,
  label?: string,
  locatorTypeId: TypeId = typeId,
): Browseable {
  const rel = normalizeRel(absRel);
  return folderNode(explorerCtx(typeId, scope, locatorTypeId), rel, label ?? (basename(rel) || rel));
}

/** Assets-body variant of `fsFolderNode`: rows address the Assets fs/ file
 *  manager (`/dock/assets/fs/<rel>`) instead of the Explorer, and are
 *  draggable. Used by the Assets navigator's context-folder rows so a context
 *  folder expands into its real on-disk tree. `folderDrop` (optional) makes
 *  every folder in the subtree a drop target bound to its own rel path. */
export function assetsFsFolderNode(
  typeId: TypeId,
  absRel: string,
  label?: string,
  folderDrop?: (rel: string) => FsFolderDrop,
  locatorTypeId: TypeId = LOCAL_COMPUTE_NODE,
): Browseable {
  const rel = normalizeRel(absRel);
  const ctx: FsNodeCtx = {
    typeId,
    locatorTypeId,
    pointerFor: (path) => DockPointer.forAssetFs(path),
    filePointerFor: fsFileViewerPointerForVfs,
    draggable: true,
    folderDrop,
  };
  return folderNode(ctx, rel, label ?? (basename(rel) || rel));
}

/** Imperative single-folder listing — the same `fsStore` path SimpleFileManager
 *  uses, so the tree and the table share one browse cache. Folders sort before
 *  files; both alphabetical. */
async function listChildrenAt(ctx: FsNodeCtx, dirRel: string, opts?: { refresh?: boolean }): Promise<Browseable[]> {
  const path = toFsPath(dirRel);
  if (opts?.refresh) fsStore.getState().invalidate(ctx.typeId, path, 'browse');
  const result = await fsStore.getState().listDirectory(ctx.typeId, path);
  const dirs: Browseable[] = [];
  const files: Browseable[] = [];
  for (const item of result.items as FSItem[]) {
    // Items read back from the fsStore cache have been through Immer, which
    // strips class GETTERS (`relativePath`) — only enumerable instance fields
    // survive (see the FSItem.name comment). Parse the surviving raw
    // `vfs_abs_path` field instead, or the whole listing reads as empty on a
    // cache hit (fresh fetches worked; re-reads showed "Empty").
    const childRel = normalizeRel(VFSPath.parse(item.vfs_abs_path).entitySubPath);
    if (!childRel) continue;
    const name = basename(childRel) || item.name || childRel;
    if (item.is_dir) dirs.push(folderNode(ctx, childRel, name));
    else files.push(fileNode(ctx, childRel, name));
  }
  dirs.sort((a, b) => a.label.localeCompare(b.label));
  files.sort((a, b) => a.label.localeCompare(b.label));
  return [...dirs, ...files];
}

/** Resolve a route pointer to this root's canonical VFS identity. Project VFS
 *  pointers are projected into the compute-node mount; every other pointer
 *  must already name the same locator TypeId as the root. */
function resourceForPointer(
  ctx: FsNodeCtx,
  projectRootPath: string | null | undefined,
  pointer: DockPointer,
): VFSPath | null {
  const resource = pointer.resourceVfsPath;
  if (!resource?.typeId) return null;
  if (resource.typeId.type === 'project' && projectRootPath) {
    return VFSPath.fromTypeId(ctx.locatorTypeId, joinRel(projectRootPath, resource.entitySubPath));
  }
  return resource.typeId.equals(ctx.locatorTypeId) ? resource : null;
}

/** Resolve the root→target ancestor chain for a deep-link pointer (sync; the
 *  whole chain is derivable from the path without listing). */
function resolveChain(root: BrowseableRoot, ctx: FsNodeCtx, anchor: string, relRaw: string | null): Browseable[] {
  if (relRaw === null) return [root];
  const segs = normalizeRel(relRaw) ? normalizeRel(relRaw).split('/') : [];
  const fileLabel = segs.length && looksLikeFile(segs[segs.length - 1]) ? segs.pop() : null;
  const rel = segs.join('/');

  const underAnchor = anchor === '' || rel === anchor || rel.startsWith(`${anchor}/`);
  if (!underAnchor) return [root];

  const chain: Browseable[] = [root];
  const extra = anchor ? rel.slice(anchor.length).replace(/^\/+/, '') : rel;
  if (!extra) return chain;
  let cur = anchor;
  for (const seg of extra.split('/')) {
    cur = cur ? `${cur}/${seg}` : seg;
    chain.push(folderNode(ctx, cur, seg));
  }
  if (fileLabel) {
    const fileRel = cur ? `${cur}/${fileLabel}` : fileLabel;
    chain.push(fileNode(ctx, fileRel, fileLabel));
  }
  return chain;
}

export function fsFolderRoot(deps: FsFolderRootDeps): BrowseableRoot {
  const { typeId, scope, label, rootIcon, projectRootPath } = deps;
  const anchor = normalizeRel(deps.anchorRelPath);
  const locatorTypeId = deps.locatorTypeId ?? typeId;
  const ctx: FsNodeCtx = {
    typeId,
    locatorTypeId,
    pointerFor: deps.pointerForVfs ?? ((path) => DockPointer.forExplorer(path.absVfsPath).withScopeFilter(scope)),
    filePointerFor: deps.filePointerForVfs,
    draggable: deps.draggable ?? false,
  };

  const root: BrowseableRoot = {
    id: fsRootNodeId(typeId, anchor),
    kind: 'root',
    label,
    icon: rootIcon ?? <Folder className="h-4 w-4 flex-shrink-0 text-muted-foreground" />,
    hasChildren: true,
    pointer: ctx.pointerFor(vfsForRel(ctx, anchor)),
    listChildren: (opts) => listChildrenAt(ctx, anchor, opts),
    ownsPointer: (pointer) => {
      const resource = resourceForPointer(ctx, projectRootPath, pointer);
      if (!resource) return false;
      const rel = normalizeRel(resource.entitySubPath);
      return anchor === '' || rel === anchor || rel.startsWith(`${anchor}/`);
    },
    // Resolution is synchronous (no per-folder fetch needed to build the chain),
    // but the protocol types `pathFor` as async.
    pathFor: (pointer) => {
      const resource = resourceForPointer(ctx, projectRootPath, pointer);
      return Promise.resolve(resolveChain(root, ctx, anchor, resource?.entitySubPath ?? null));
    },
  };
  return root;
}
