import { TypeId } from '@sdk';
import { FolderTree } from 'lucide-react';
import type { ScopeFilter } from '@src/lib/scope-filter';
import type { Browseable, BrowseableRoot } from '@src/components/browseable-tree/types';
import { fsFolderNode } from './fsFolderRoot';

/**
 * contextFoldersRoot — the Explorer's `context_folders` grouping root.
 *
 * Lists a project's `include_dirs` (context folders) as browseable filesystem
 * folders. Each child is a real `fsFolderRoot`-style folder node anchored at the
 * dir's absolute compute-node path, so it lazily lists + expands via the same
 * `fsStore.listDirectory` machinery as every other Explorer folder.
 *
 * It is a pure browse entry point: it does NOT own pointers (`ownsPointer` is
 * always false) so deep-link auto-expand stays with the scope root — clicking a
 * context-folder child still navigates the Explorer table, but selection/chain
 * resolution is left to the main filesystem root. The grouping row itself has a
 * null pointer (header-only; clicking just toggles the chevron).
 */
export interface ContextFoldersRootDeps {
  /** Live compute_node TypeId whose VFS we browse. */
  typeId: TypeId;
  /** Active scope — stamped onto each child pointer so clicks keep the filter. */
  scope: ScopeFilter;
  /** Absolute canonical posix paths of the project's context folders. */
  dirs: string[];
}

export function contextFoldersRoot(deps: ContextFoldersRootDeps): BrowseableRoot {
  const { typeId, scope, dirs } = deps;
  const root: BrowseableRoot = {
    id: `context-folders-root:${typeId.toString()}`,
    kind: 'root',
    label: 'context_folders',
    icon: <FolderTree className="h-4 w-4 flex-shrink-0 text-muted-foreground" />,
    hasChildren: dirs.length > 0,
    pointer: null,
    // fsFolderNode defaults its label to the folder basename.
    listChildren: (): Promise<Browseable[]> =>
      Promise.resolve(dirs.map((d) => fsFolderNode(typeId, scope, d))),
    ownsPointer: () => false,
    pathFor: () => Promise.resolve([root]),
  };
  return root;
}
