import { FSItem, TypeId, VFSPath, fsStore } from '@sdk';
import { File, Folder } from 'lucide-react';
import type { ReactNode } from 'react';
import { DockPointer, normalizeRel } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import type { ScopeFilter } from '@src/lib/scope-filter';
import type { Browseable, BrowseableDragData, BrowseableRoot } from '@src/components/browseable-tree/types';

/**
 * fsFolderRoot — a real-filesystem browseable root.
 *
 * Structurally mirrors `markdownFolderRoot`, but instead of a one-shot
 * gitignore-aware walk it lists **per folder, lazily** via the proven
 * SimpleFileManager path (`fsStore.listDirectory`). One root anchors the tree at
 * a single VFS folder. By default every node addresses the Explorer by a
 * vfs-path `DockPointer.forExplorer(...)` carrying the active scope (the
 * Explorer left menu); a host can swap the pointer grammar via `pointerForRel`
 * (+ `ownsPointer`/`relForPointer` for deep-link expansion) — the Assets
 * navigator's "Files" root does this to address the Assets body's `fs/` file
 * manager instead.
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
  /** Pointer grammar override: build the pointer a row navigates to from its
   *  entity-relative path. Default: `DockPointer.forExplorer` + scope. */
  pointerForRel?: (rel: string) => DockPointer;
  /** Deep-link ownership override, paired with `pointerForRel`. Default: any
   *  Explorer pointer. */
  ownsPointer?: (p: DockPointer) => boolean;
  /** Deep-link path resolution override, paired with `pointerForRel`: pointer →
   *  entity-relative path (null = not addressable here). Default: the Explorer
   *  vfs parse (with project remap via `projectRootPath`). */
  relForPointer?: (p: DockPointer) => string | null;
  /** When true, file/folder rows carry an `FsDragItem` drag payload so drop
   *  targets (e.g. the Assets context-folder rows) can accept them. */
  draggable?: boolean;
}

/** Drag payload for a real-filesystem row (file or folder), emitted when the
 *  root is built with `draggable`. `relPath` is entity-relative (no leading
 *  slash) on the root's compute-node TypeId. */
export interface FsDragItem extends BrowseableDragData {
  kind: 'fs-item';
  relPath: string;
  isDir: boolean;
}

export function isFsDragItem(data: BrowseableDragData): data is FsDragItem {
  return data.kind === 'fs-item' && typeof data.relPath === 'string' && typeof data.isDir === 'boolean';
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

function explorerPointerFor(typeId: TypeId, scope: ScopeFilter, rel: string): DockPointer {
  const r = normalizeRel(rel);
  const path = r ? `${typeId.toString()}/${r}` : `${typeId.toString()}/`;
  return DockPointer.forExplorer(path).withScopeFilter(scope);
}

/** Per-root node context: which VFS the rows list, how they address the body
 *  (pointer grammar), and whether they can be dragged. One ctx per root keeps
 *  the recursive node builders free of per-variant branching. */
interface FsNodeCtx {
  typeId: TypeId;
  pointerFor: (rel: string) => DockPointer;
  draggable: boolean;
}

function explorerCtx(typeId: TypeId, scope: ScopeFilter): FsNodeCtx {
  return { typeId, pointerFor: (rel) => explorerPointerFor(typeId, scope, rel), draggable: false };
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
    // Leaves are not openable from the tree; the table opens files. A click here
    // just lands the file manager on the file (its parent dir, via the body's
    // file-detection), so the table shows the containing folder.
    hasChildren: false,
    pointer: ctx.pointerFor(rel),
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
    pointer: ctx.pointerFor(rel),
    listChildren: (opts) => listChildrenAt(ctx, rel, opts),
    dragData: dragDataFor(ctx, id, rel, label, true),
  };
}

/** Public factory: a browseable folder node addressing an absolute compute-node
 *  path (leading slash stripped to the entity-relative form the VFS uses). Used
 *  by the Explorer's `context_folders` grouping root, which lists project
 *  `include_dirs` that may live anywhere on the compute node's VFS. */
export function fsFolderNode(typeId: TypeId, scope: ScopeFilter, absRel: string, label?: string): Browseable {
  const rel = normalizeRel(absRel);
  return folderNode(explorerCtx(typeId, scope), rel, label ?? (basename(rel) || rel));
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
    const childRel = normalizeRel(item.relativePath || '');
    if (!childRel) continue;
    const name = basename(childRel) || item.name || childRel;
    if (item.is_dir) dirs.push(folderNode(ctx, childRel, name));
    else files.push(fileNode(ctx, childRel, name));
  }
  dirs.sort((a, b) => a.label.localeCompare(b.label));
  files.sort((a, b) => a.label.localeCompare(b.label));
  return [...dirs, ...files];
}

/** Default (Explorer) pointer → entity-relative path resolution. A stale
 *  compute_node id is ignored (we only take the subpath + use the live typeId);
 *  a project-typed pointer is remapped under the known project mount. */
function explorerRelForPointer(projectRootPath: string | null | undefined, p: DockPointer): string {
  const vfs = VFSPath.parse(p.pointer);
  if (vfs.typeId?.type === 'project' && projectRootPath) {
    return joinRel(projectRootPath, vfs.entitySubPath);
  }
  return normalizeRel(vfs.entitySubPath);
}

/** Resolve the root→target ancestor chain for a deep-link pointer (sync; the
 *  whole chain is derivable from the path without listing). */
function resolveChain(root: BrowseableRoot, ctx: FsNodeCtx, anchor: string, relRaw: string | null): Browseable[] {
  if (relRaw === null) return [root];
  // Trim a file leaf to its parent dir (the tree expands the folder; the file
  // shows as a child row).
  const segs = normalizeRel(relRaw) ? normalizeRel(relRaw).split('/') : [];
  if (segs.length && looksLikeFile(segs[segs.length - 1])) segs.pop();
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
  return chain;
}

export function fsFolderRoot(deps: FsFolderRootDeps): BrowseableRoot {
  const { typeId, scope, label, rootIcon, projectRootPath } = deps;
  const anchor = normalizeRel(deps.anchorRelPath);
  const ctx: FsNodeCtx = {
    typeId,
    pointerFor: deps.pointerForRel ?? ((rel) => explorerPointerFor(typeId, scope, rel)),
    draggable: deps.draggable ?? false,
  };
  const relForPointer = deps.relForPointer ?? ((p: DockPointer) => explorerRelForPointer(projectRootPath, p));

  const root: BrowseableRoot = {
    id: fsRootNodeId(typeId, anchor),
    kind: 'root',
    label,
    icon: rootIcon ?? <Folder className="h-4 w-4 flex-shrink-0 text-muted-foreground" />,
    hasChildren: true,
    pointer: ctx.pointerFor(anchor),
    listChildren: (opts) => listChildrenAt(ctx, anchor, opts),
    ownsPointer: deps.ownsPointer ?? ((p) => p.viewType === ViewType.EXPLORER),
    // Resolution is synchronous (no per-folder fetch needed to build the chain),
    // but the protocol types `pathFor` as async.
    pathFor: (p) => Promise.resolve(resolveChain(root, ctx, anchor, relForPointer(p))),
  };
  return root;
}
