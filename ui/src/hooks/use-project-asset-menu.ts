import { useMemo } from 'react';
import type { Project, ProjectAssetMenu, ProjectMenuNode } from '@sdk';
import { LazyAsset } from '@sdk/lazy';
import { useLazyAsset } from '@sdk/react/hooks/useLazyAsset';

/**
 * useProjectAssetMenu — the scoped project's Assets menu, computed server-side.
 *
 * Backs two things in the Assets navigator: the per-type counts (which decide
 * WHICH type rows exist, not just their badges) and the nested menu under each
 * dependency row. Because the backend walks dependencies recursively, a
 * folder that is itself a Project contributes its own dependencies too.
 *
 * Read-only: `get-assets` in menu mode mints nothing and indexes nothing, so
 * calling this can never change what it reports. The shared read (and its
 * refresh on a create / delete of a listed type) lives in the SDK lazy asset.
 *
 * Keyed on the project's `include_dirs` CONTENT, not its identity: entity
 * updates refill the SAME array instance (`store.deepAssign`), so an identity
 * key would freeze this at the first (usually empty) snapshot — the same race
 * `useProjectDependencies` documents.
 */
export function useProjectAssetMenu(project: Project | null | undefined): {
  menu: ProjectAssetMenu | null;
  /** Every node of the tree keyed by its canonical path, for O(1) lookup while
   *  building rows. Empty until the first response lands. */
  nodesByPath: Map<string, ProjectMenuNode>;
  isLoading: boolean;
  refresh: () => Promise<unknown>;
} {
  const projectId = project?.id ?? '';
  const contextDirs = JSON.stringify(project?.include_dirs ?? []);
  const { data, isLoading, reload } = useLazyAsset(
    LazyAsset.ProjectAssetMenu,
    { projectId, contextDirs },
    { enabled: !!projectId },
  );
  const menu = projectId ? (data ?? null) : null;

  const nodesByPath = useMemo(() => {
    const out = new Map<string, ProjectMenuNode>();
    const visit = (node: ProjectMenuNode) => {
      out.set(node.path, node);
      for (const child of node.children ?? []) visit(child);
    };
    if (menu?.root) visit(menu.root);
    return out;
  }, [menu]);

  return { menu, nodesByPath, isLoading, refresh: reload };
}
