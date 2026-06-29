import { FSItem, TypeId, VFSPath, fsStore } from '@sdk';
import { File, Folder } from 'lucide-react';
import type { ReactNode } from 'react';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import type { ScopeFilter } from '@src/lib/scope-filter';
import type { Browseable, BrowseableRoot } from '@src/components/browseable-tree/types';

/**
 * fsFolderRoot — a real-filesystem browseable root for the Explorer left menu.
 *
 * Structurally mirrors `markdownFolderRoot`, but instead of a one-shot
 * gitignore-aware walk it lists **per folder, lazily** via the proven
 * SimpleFileManager path (`fsStore.listDirectory`). One root anchors the tree at
 * a single VFS folder (the scope filter selects which: All → `/`, User → home,
 * Project → the project mount); every node addresses the Explorer by a vfs-path
 * `DockPointer.forExplorer(...)` carrying the active scope.
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
}

function normalizeRel(path: string | null | undefined): string {
  if (!path) return '';
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

function toFsPath(rel: string): string {
  const r = normalizeRel(rel);
  return r ? `/${r}` : '/';
}

function basename(rel: string): string {
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

function pointerFor(typeId: TypeId, scope: ScopeFilter, rel: string): DockPointer {
  const r = normalizeRel(rel);
  const path = r ? `${typeId.toString()}/${r}` : `${typeId.toString()}/`;
  return DockPointer.forExplorer(path).withScopeFilter(scope);
}

function fileNode(typeId: TypeId, scope: ScopeFilter, rel: string, label: string): Browseable {
  return {
    id: `fs-file:${typeId.toString()}:${normalizeRel(rel)}`,
    kind: 'file',
    label,
    icon: <File className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />,
    // Leaves are not openable from the tree; the table opens files. A click here
    // just lands the Explorer on the file (its parent dir, via the body's
    // file-detection), so the table shows the containing folder.
    hasChildren: false,
    pointer: pointerFor(typeId, scope, rel),
  };
}

function folderNode(typeId: TypeId, scope: ScopeFilter, rel: string, label: string): Browseable {
  return {
    id: fsFolderNodeId(typeId, rel),
    kind: 'folder',
    label,
    icon: <Folder className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />,
    hasChildren: true,
    pointer: pointerFor(typeId, scope, rel),
    listChildren: (opts) => listChildrenAt(typeId, scope, rel, opts),
  };
}

/** Imperative single-folder listing — the same `fsStore` path SimpleFileManager
 *  uses, so the tree and the table share one browse cache. Folders sort before
 *  files; both alphabetical. */
async function listChildrenAt(
  typeId: TypeId,
  scope: ScopeFilter,
  dirRel: string,
  opts?: { refresh?: boolean },
): Promise<Browseable[]> {
  const path = toFsPath(dirRel);
  if (opts?.refresh) fsStore.getState().invalidate(typeId, path, 'browse');
  const result = await fsStore.getState().listDirectory(typeId, path);
  const dirs: Browseable[] = [];
  const files: Browseable[] = [];
  for (const item of result.items as FSItem[]) {
    const childRel = normalizeRel(item.relativePath || '');
    if (!childRel) continue;
    const name = basename(childRel) || item.name || childRel;
    if (item.is_dir) dirs.push(folderNode(typeId, scope, childRel, name));
    else files.push(fileNode(typeId, scope, childRel, name));
  }
  dirs.sort((a, b) => a.label.localeCompare(b.label));
  files.sort((a, b) => a.label.localeCompare(b.label));
  return [...dirs, ...files];
}

/** Resolve the root→target ancestor chain for a deep-link pointer (sync; the
 *  whole chain is derivable from the path without listing). */
function resolveChain(
  root: BrowseableRoot,
  typeId: TypeId,
  scope: ScopeFilter,
  anchor: string,
  projectRootPath: string | null | undefined,
  p: DockPointer,
): Browseable[] {
  const vfs = VFSPath.parse(p.pointer);
  // Resolve the pointer to a compute-node-relative path. A stale compute_node id
  // is ignored (we only take the subpath + use the live typeId); a project-typed
  // pointer is remapped under the known project mount.
  let rel: string;
  if (vfs.typeId?.type === 'project' && projectRootPath) {
    rel = joinRel(projectRootPath, vfs.entitySubPath);
  } else {
    rel = normalizeRel(vfs.entitySubPath);
  }
  // Trim a file leaf to its parent dir (the tree expands the folder; the file
  // shows as a child row).
  const segs = rel ? rel.split('/') : [];
  if (segs.length && looksLikeFile(segs[segs.length - 1])) segs.pop();
  rel = segs.join('/');

  const underAnchor = anchor === '' || rel === anchor || rel.startsWith(`${anchor}/`);
  if (!underAnchor) return [root];

  const chain: Browseable[] = [root];
  const extra = anchor ? rel.slice(anchor.length).replace(/^\/+/, '') : rel;
  if (!extra) return chain;
  let cur = anchor;
  for (const seg of extra.split('/')) {
    cur = cur ? `${cur}/${seg}` : seg;
    chain.push(folderNode(typeId, scope, cur, seg));
  }
  return chain;
}

export function fsFolderRoot(deps: FsFolderRootDeps): BrowseableRoot {
  const { typeId, scope, label, rootIcon, projectRootPath } = deps;
  const anchor = normalizeRel(deps.anchorRelPath);

  const root: BrowseableRoot = {
    id: fsRootNodeId(typeId, anchor),
    kind: 'root',
    label,
    icon: rootIcon ?? <Folder className="h-4 w-4 flex-shrink-0 text-muted-foreground" />,
    hasChildren: true,
    pointer: pointerFor(typeId, scope, anchor),
    listChildren: (opts) => listChildrenAt(typeId, scope, anchor, opts),
    ownsPointer: (p) => p.viewType === ViewType.EXPLORER,
    // Resolution is synchronous (no per-folder fetch needed to build the chain),
    // but the protocol types `pathFor` as async.
    pathFor: (p) => Promise.resolve(resolveChain(root, typeId, scope, anchor, projectRootPath, p)),
  };
  return root;
}
