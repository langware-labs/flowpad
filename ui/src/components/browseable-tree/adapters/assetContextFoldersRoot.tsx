import { Folder, FolderPlus, FolderTree, GitBranch, Trash2 } from 'lucide-react';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import type { ProjectContextDirInfo, TypeId } from '@sdk';
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
}

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

function dirNode(
  info: ProjectContextDirInfo,
  fsTypeId: AssetContextFoldersRootDeps['fsTypeId'],
  onRemove: AssetContextFoldersRootDeps['onRemove'],
  onDropItem: AssetContextFoldersRootDeps['onDropItem'],
  onExternalDrop: AssetContextFoldersRootDeps['onExternalDrop'],
  projectId: AssetContextFoldersRootDeps['projectId'],
): Browseable {
  const dir = info.path;
  const isGit = info.origin_kind === 'git';
  const rel = normalizeRel(dir);
  // With a compute node the row is a real expandable fs folder (lazy browse,
  // same cache as the body's file manager); without one it stays a leaf.
  // Its whole subtree accepts drops, each folder bound to its own path.
  const fsNode = fsTypeId
    ? assetsFsFolderNode(fsTypeId, rel, undefined, subfolderDrop(onDropItem, onExternalDrop))
    : null;
  return {
    ...fsNode,
    id: assetContextFolderNodeId(dir),
    kind: 'folder',
    label: basename(rel) || rel,
    icon: isGit ? (
      <GitBranch className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
    ) : (
      <Folder className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
    ),
    hasChildren: !!fsNode,
    // Git rows carry the status-bar pill pair (changes count + Push) as an
    // always-visible badge; renders nothing while the repo is clean.
    badge:
      isGit && fsTypeId ? (
        <ContextFolderGitBadge
          workdir={`/${rel}`}
          computeNodeId={fsTypeId.id}
          folderName={basename(rel) || rel}
          folderTypeId={info.typeid || null}
          projectId={projectId}
        />
      ) : undefined,
    pointer: DockPointer.forAssetFsFolder(rel),
    canDrop: onDropItem ? (data) => canDropIntoDir(dir, data) : undefined,
    onDrop: onDropItem
      ? async (data) => {
          if (!isFsDragItem(data) || !canDropIntoDir(dir, data)) return;
          await onDropItem(data, dir);
        }
      : undefined,
    onExternalFilesDrop: onExternalDrop ? (entries) => onExternalDrop(entries, dir) : undefined,
    toolbar: [
      {
        id: 'remove',
        icon: <Trash2 className="h-3 w-3" />,
        label: 'Remove context folder',
        run: () => onRemove(dir),
      },
    ],
  };
}

export function assetContextFoldersRoot(deps: AssetContextFoldersRootDeps): BrowseableRoot {
  const { dirs, fsTypeId, onAdd, onRemove, onDropItem, onExternalDrop, projectId } = deps;
  const root: BrowseableRoot = {
    id: 'asset-context-folders-root',
    kind: 'root',
    label: 'Context folders',
    icon: <FolderTree className="h-4 w-4 flex-shrink-0 text-muted-foreground" />,
    hasChildren: dirs.length > 0,
    pointer: null,
    listChildren: (): Promise<Browseable[]> =>
      Promise.resolve(dirs.map((info) => dirNode(info, fsTypeId, onRemove, onDropItem, onExternalDrop, projectId))),
    toolbar: [
      {
        id: 'add',
        icon: <FolderPlus className="h-3.5 w-3.5" />,
        label: 'Add context folder',
        run: onAdd,
      },
    ],
    ownsPointer: (p) => p.viewType === ViewType.ASSETS && DockPointer.parseAssetFsPointer(p.pointer) !== null,
    pathFor: (p) => {
      const rel = normalizeRel(DockPointer.parseAssetFsPointer(p.pointer) ?? '');
      const match = dirs.find((info) => {
        const dr = normalizeRel(info.path);
        return rel === dr || rel.startsWith(`${dr}/`);
      });
      if (!match) return Promise.resolve([root]);
      const chain: Browseable[] = [root, dirNode(match, fsTypeId, onRemove, onDropItem, onExternalDrop, projectId)];
      // Deep-link below the context dir: chain the intermediate fs folder
      // nodes (same ids listChildren produces) so the tree auto-expands.
      if (fsTypeId) {
        const dirRel = normalizeRel(match.path);
        const extra = rel === dirRel ? '' : rel.slice(dirRel.length).replace(/^\/+/, '');
        let cur = dirRel;
        for (const seg of extra ? extra.split('/') : []) {
          cur = `${cur}/${seg}`;
          chain.push(assetsFsFolderNode(fsTypeId, cur, seg, subfolderDrop(onDropItem, onExternalDrop)));
        }
      }
      return Promise.resolve(chain);
    },
  };
  return root;
}
