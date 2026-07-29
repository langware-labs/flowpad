import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Project, ProjectAssetMenu, ProjectMenuNode } from '@sdk';

/**
 * useProjectAssetMenu — the scoped project's Assets menu, computed server-side.
 *
 * Backs two things in the Assets navigator: the per-type counts (which decide
 * WHICH type rows exist, not just their badges) and the nested menu under each
 * context-folder row. Because the backend walks context folders recursively, a
 * folder that is itself a Project contributes its own context folders too.
 *
 * Read-only: `get-assets` in menu mode mints nothing and indexes nothing, so
 * calling this can never change what it reports.
 *
 * Refetch is keyed on the project's `include_dirs` CONTENT, not its identity:
 * entity updates refill the SAME array instance (`store.deepAssign`), so an
 * identity dep would freeze this at the first (usually empty) snapshot — the
 * same race `useProjectContextFolders` documents.
 */
export function useProjectAssetMenu(project: Project | null | undefined): {
  menu: ProjectAssetMenu | null;
  /** Every node of the tree keyed by its canonical path, for O(1) lookup while
   *  building rows. Empty until the first response lands. */
  nodesByPath: Map<string, ProjectMenuNode>;
  isLoading: boolean;
  refresh: () => Promise<void>;
} {
  const [menu, setMenu] = useState<ProjectAssetMenu | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const projectRef = useRef<Project | null>(null);
  projectRef.current = project ?? null;
  // Discards a stale response when the project changes mid-flight (same
  // tick-guard as useProcessAssets).
  const tickRef = useRef(0);

  const refresh = useCallback(async () => {
    const p = projectRef.current;
    const tick = ++tickRef.current;
    if (!p) {
      setMenu(null);
      return;
    }
    setIsLoading(true);
    try {
      const next = await p.getAssetMenu();
      if (tickRef.current === tick) setMenu(next);
    } catch (err) {
      console.error('[useProjectAssetMenu] failed', err);
      if (tickRef.current === tick) setMenu(null);
    } finally {
      if (tickRef.current === tick) setIsLoading(false);
    }
  }, []);

  const projectId = project?.id ?? null;
  const contextDirsKey = JSON.stringify(project?.include_dirs ?? []);
  useEffect(() => {
    void refresh();
  }, [projectId, contextDirsKey, refresh]);

  const nodesByPath = useMemo(() => {
    const out = new Map<string, ProjectMenuNode>();
    const visit = (node: ProjectMenuNode) => {
      out.set(node.path, node);
      for (const child of node.children ?? []) visit(child);
    };
    if (menu?.root) visit(menu.root);
    return out;
  }, [menu]);

  return { menu, nodesByPath, isLoading, refresh };
}
