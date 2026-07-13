import { Folder, FolderPlus, FolderTree, GitBranch, X } from 'lucide-react';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import type { ProjectContextDirInfo } from '@sdk';
import type {
  Browseable,
  BrowseableDragData,
  BrowseableRoot,
  DroppedFileEntry,
} from '@src/components/browseable-tree/types';
import { basename, isFsDragItem, normalizeRel, type FsDragItem } from './fsFolderRoot';

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
  const src = normalizeRel(data.relPath);
  const dest = normalizeRel(dir);
  if (!src) return false;
  // No-op / cycle guards: already directly inside the target, or dropping a
  // folder into itself or its own descendant.
  if (parentRel(src) === dest) return false;
  if (data.isDir && (src === dest || dest.startsWith(`${src}/`))) return false;
  return true;
}

function dirNode(
  info: ProjectContextDirInfo,
  onRemove: AssetContextFoldersRootDeps['onRemove'],
  onDropItem: AssetContextFoldersRootDeps['onDropItem'],
  onExternalDrop: AssetContextFoldersRootDeps['onExternalDrop'],
): Browseable {
  const dir = info.path;
  const isGit = info.origin_kind === 'git';
  const rel = normalizeRel(dir);
  return {
    id: assetContextFolderNodeId(dir),
    kind: 'folder',
    label: basename(rel) || rel,
    icon: isGit ? (
      <GitBranch className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
    ) : (
      <Folder className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
    ),
    // Leaf in the tree — the body's file explorer does the deep browsing.
    hasChildren: false,
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
        icon: <X className="h-3 w-3" />,
        label: 'Remove context folder',
        run: () => onRemove(dir),
      },
    ],
  };
}

export function assetContextFoldersRoot(deps: AssetContextFoldersRootDeps): BrowseableRoot {
  const { dirs, onAdd, onRemove, onDropItem, onExternalDrop } = deps;
  const root: BrowseableRoot = {
    id: 'asset-context-folders-root',
    kind: 'root',
    label: 'Context folders',
    icon: <FolderTree className="h-4 w-4 flex-shrink-0 text-muted-foreground" />,
    hasChildren: dirs.length > 0,
    pointer: null,
    listChildren: (): Promise<Browseable[]> =>
      Promise.resolve(dirs.map((info) => dirNode(info, onRemove, onDropItem, onExternalDrop))),
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
      return Promise.resolve(match ? [root, dirNode(match, onRemove, onDropItem, onExternalDrop)] : [root]);
    },
  };
  return root;
}
