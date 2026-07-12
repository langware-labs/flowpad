import { Folder, FolderPlus, FolderTree, X } from 'lucide-react';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import type { Browseable, BrowseableRoot } from '@src/components/browseable-tree/types';
import { basename, normalizeRel } from './fsFolderRoot';

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
  /** Absolute canonical posix paths of the project's context folders. */
  dirs: string[];
  /** "Add context folder" toolbar action (native folder picker → add). */
  onAdd: () => void | Promise<void>;
  /** Per-row remove action. */
  onRemove: (dir: string) => void | Promise<void>;
}

export function assetContextFolderNodeId(dir: string): string {
  return `asset-context-folder:${normalizeRel(dir) || '/'}`;
}

function dirNode(dir: string, onRemove: AssetContextFoldersRootDeps['onRemove']): Browseable {
  const rel = normalizeRel(dir);
  return {
    id: assetContextFolderNodeId(dir),
    kind: 'folder',
    label: basename(rel) || rel,
    icon: <Folder className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />,
    // Leaf in the tree — the body's file explorer does the deep browsing.
    hasChildren: false,
    pointer: DockPointer.forAssetFsFolder(rel),
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
  const { dirs, onAdd, onRemove } = deps;
  const root: BrowseableRoot = {
    id: 'asset-context-folders-root',
    kind: 'root',
    label: 'Context folders',
    icon: <FolderTree className="h-4 w-4 flex-shrink-0 text-muted-foreground" />,
    hasChildren: dirs.length > 0,
    pointer: null,
    listChildren: (): Promise<Browseable[]> =>
      Promise.resolve(dirs.map((d) => dirNode(d, onRemove))),
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
      const match = dirs.find((d) => {
        const dr = normalizeRel(d);
        return rel === dr || rel.startsWith(`${dr}/`);
      });
      return Promise.resolve(match ? [root, dirNode(match, onRemove)] : [root]);
    },
  };
  return root;
}
