import { useCallback, useMemo, useRef } from 'react';
import { dataContext, type Project, type ProjectContextDirInfo } from '@sdk';

export type ContextFolderScope = 'private' | 'shared';

/**
 * useProjectContextFolders — the shared mutation surface for a project's
 * context folders (`include_dirs`). Consumed by every UI that edits them
 * (the ProjectHome `ContextFolders` card, the Assets navigator root) so the
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

  // CONTENT-keyed memos, not identity-keyed: entity updates fill the SAME
  // array instance in place (store.deepAssign), so the reference never changes
  // and an identity dep would freeze these at their first (often pre-fetch,
  // empty) snapshot — the "context folders vanish until another refresh" race.
  const contextDirsKey = JSON.stringify(project?.include_dirs ?? []);
  const contextDirs = useMemo<string[]>(
    () => (project?.include_dirs ?? []).filter((d): d is string => !!d),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [contextDirsKey],
  );

  /** Same dirs with their origin kind ("git" for cloned repos, else "local"). */
  const contextDirInfosKey = JSON.stringify(project?.context_dir_infos ?? []);
  const contextDirInfos = useMemo<ProjectContextDirInfo[]>(
    () => (project?.context_dir_infos ?? []).filter((i): i is ProjectContextDirInfo => !!i?.path),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [contextDirInfosKey],
  );

  /** Add each given absolute folder path (idempotent server-side). The scope
   *  selects the context bucket: private (default, never leaves this machine)
   *  or shared (travels with the project). */
  const addPaths = useCallback(async (paths: string[], scope: ContextFolderScope = 'private') => {
    const p = projectRef.current;
    if (!p) return;
    for (const path of paths) {
      if (path) await p.addContextDir(path, scope);
    }
  }, []);

  /** Native folder picker → add. No-op without a compute node. */
  const pickAndAdd = useCallback(async (scope: ContextFolderScope = 'private') => {
    const p = projectRef.current;
    const computeNode = dataContext.computeNode;
    if (!p || !computeNode) return;
    const picked = await computeNode.openPathDialog();
    if (picked) await p.addContextDir(picked, scope);
  }, []);

  const remove = useCallback(async (dir: string) => {
    const p = projectRef.current;
    if (!p) return;
    await p.removeContextDir(dir);
  }, []);

  return { contextDirs, contextDirInfos, addPaths, pickAndAdd, remove } as const;
}
