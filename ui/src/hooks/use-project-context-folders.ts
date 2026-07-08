import { useCallback, useMemo, useRef } from 'react';
import { dataContext, type Project } from '@sdk';

/**
 * useProjectContextFolders — the shared mutation surface for a project's
 * context folders (`include_dirs`). Consumed by every UI that edits them
 * (the ProjectBrief `ContextFolders` card, the Assets navigator root) so the
 * add / native-pick / remove flows live once.
 *
 * The callbacks read the project through a ref, so their identity is stable
 * across entity updates — hosts can safely feed them into memoized structures
 * (e.g. the Assets `roots` tree) without churning on unrelated project-field
 * changes. Reactivity comes from `contextDirs`, derived from the watched
 * entity's `include_dirs`.
 */
export function useProjectContextFolders(project: Project | null | undefined) {
  const projectRef = useRef<Project | null>(null);
  projectRef.current = project ?? null;

  const contextDirs = useMemo<string[]>(
    () => (project?.include_dirs ?? []).filter((d): d is string => !!d),
    [project?.include_dirs],
  );

  /** Add each given absolute folder path (idempotent server-side). */
  const addPaths = useCallback(async (paths: string[]) => {
    const p = projectRef.current;
    if (!p) return;
    for (const path of paths) {
      if (path) await p.addContextDir(path);
    }
  }, []);

  /** Native folder picker → add. No-op without a compute node. */
  const pickAndAdd = useCallback(async () => {
    const p = projectRef.current;
    const computeNode = dataContext.computeNode;
    if (!p || !computeNode) return;
    const picked = await computeNode.openPathDialog();
    if (picked) await p.addContextDir(picked);
  }, []);

  const remove = useCallback(async (dir: string) => {
    const p = projectRef.current;
    if (!p) return;
    await p.removeContextDir(dir);
  }, []);

  return { contextDirs, addPaths, pickAndAdd, remove } as const;
}
