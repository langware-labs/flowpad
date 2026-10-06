import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  dataContext,
  onProjectDependenciesChanged,
  type DependencyState,
  type Project,
  type ProjectContextDirInfo,
} from '@sdk';

/** Whether a dependency about to be added is required (fetched automatically)
 *  or optional (fetched only on Install). */
export type DependencyKind = 'required' | 'optional';

interface UseProjectDependenciesOptions {
  /** Fetch the declared dependencies' states (`GET dependencies`). Off for
   *  callers that only need the mutations or the resolved folders, so every
   *  surface that edits dependencies doesn't add a request. Default true. */
  fetchStates?: boolean;
}

/**
 * useProjectDependencies — the shared surface for a project's dependencies
 * (`flow.json` `dependencies` / `optionalDependencies`). Consumed by every UI
 * that shows or edits them (the ProjectHome Dependencies card, the Assets
 * navigator root, the missing-dependencies dialog) so the add / native-pick /
 * remove / install flows live once.
 *
 * Two views of the same thing:
 *  - `contextDirs` / `contextDirInfos` — the RESOLVED dependencies' folders,
 *    straight off the watched entity (`include_dirs`, `context_dir_infos`).
 *  - `dependencies` / `warnings` — every DECLARED dependency with its state,
 *    including ones with no local folder (missing, optional not installed).
 *    Refetched whenever the entity's context fields change (the backend
 *    resolves in the background when a project opens, and the entity update
 *    is the signal that it finished) and whenever a dependency verb on this
 *    project settles ANYWHERE — the SDK announces every one
 *    (`onProjectDependenciesChanged`), so an add from a dialog refreshes the
 *    card, the navigator and the warnings alike.
 *
 * The callbacks read the project through a ref, so their identity is stable
 * across entity updates — hosts can safely feed them into memoized structures
 * (e.g. the Assets `roots` tree).
 */
export function useProjectDependencies(
  project: Project | null | undefined,
  { fetchStates = true }: UseProjectDependenciesOptions = {},
) {
  const projectRef = useRef<Project | null>(null);
  projectRef.current = project ?? null;

  // CONTENT-keyed memos, not identity-keyed: entity updates fill the SAME
  // array instance in place (store.deepAssign), so the reference never changes
  // and an identity dep would freeze these at their first (often pre-fetch,
  // empty) snapshot — the "dependencies vanish until another refresh" race.
  const contextDirsKey = JSON.stringify(project?.include_dirs ?? []);
  const contextDirs = useMemo<string[]>(
    () => (project?.include_dirs ?? []).filter((d): d is string => !!d),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [contextDirsKey],
  );

  /** Same dirs with their origin kind ("git" for cloned repos, else "local")
   *  and the dependency each one resolves. */
  const contextDirInfosKey = JSON.stringify(project?.context_dir_infos ?? []);
  const contextDirInfos = useMemo<ProjectContextDirInfo[]>(
    () => (project?.context_dir_infos ?? []).filter((i): i is ProjectContextDirInfo => !!i?.path),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [contextDirInfosKey],
  );

  const [dependencies, setDependencies] = useState<DependencyState[]>([]);
  const [warnings, setWarnings] = useState<DependencyState[]>([]);
  // The background resolve opening the project started is still running.
  const [resolving, setResolving] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  // Discards a stale response when the project changes mid-flight (same
  // tick-guard as useProjectAssetMenu).
  const tickRef = useRef(0);

  const refetch = useCallback(async () => {
    const p = projectRef.current;
    const tick = ++tickRef.current;
    if (!p) {
      setDependencies([]);
      setWarnings([]);
      setResolving(false);
      return;
    }
    setIsLoading(true);
    try {
      const next = await p.dependencies();
      if (tickRef.current !== tick) return;
      setDependencies(next.dependencies);
      setWarnings(next.warnings);
      setResolving(next.resolving);
    } catch (err) {
      console.error('[useProjectDependencies] failed', err);
    } finally {
      if (tickRef.current === tick) setIsLoading(false);
    }
  }, []);

  const projectId = project?.id ?? null;
  useEffect(() => {
    if (fetchStates) void refetch();
  }, [fetchStates, projectId, contextDirsKey, contextDirInfosKey, refetch]);

  useEffect(() => {
    if (!fetchStates || !projectId) return;
    return onProjectDependenciesChanged(projectId, () => void refetch());
  }, [fetchStates, projectId, refetch]);

  /** Declare a dependency. `source` is anything `add-dependency` takes — a
   *  `git+…` / `hub:…` / `file:…` source, a local folder or a bare git URL.
   *  Rejects with the backend's message on a bad source. */
  const add = useCallback(
    async (source: string, kind: DependencyKind = 'required', options: { name?: string; path?: string } = {}) => {
      const p = projectRef.current;
      if (!p) return null;
      return p.addDependency(source, { ...options, optional: kind === 'optional' });
    },
    [],
  );

  /** Add each given absolute folder path as a dependency. */
  const addPaths = useCallback(
    async (paths: string[], kind: DependencyKind = 'required') => {
      for (const path of paths) {
        if (path) await add(path, kind);
      }
    },
    [add],
  );

  /** Native folder picker → add. No-op without a compute node. */
  const pickAndAdd = useCallback(
    async (kind: DependencyKind = 'required') => {
      const computeNode = dataContext.computeNode;
      if (!projectRef.current || !computeNode) return;
      const picked = await computeNode.openPathDialog();
      if (picked) await add(picked, kind);
    },
    [add],
  );

  /** Drop a dependency from `flow.json`. Its folder on disk is left alone. */
  const remove = useCallback(
    async (name: string) => {
      const p = projectRef.current;
      if (!p) return;
      await p.removeDependency(name);
    },
    [],
  );

  /** Fetch an optional dependency that is not installed yet. */
  const install = useCallback(
    async (name: string) => {
      const p = projectRef.current;
      if (!p) return null;
      return p.installDependency(name);
    },
    [],
  );

  /** Fetch whatever required dependency is missing (`update` also pulls). */
  const resolve = useCallback(
    async (options: { update?: boolean } = {}) => {
      const p = projectRef.current;
      if (!p) return;
      await p.resolveDependencies(options);
    },
    [],
  );

  return {
    contextDirs,
    contextDirInfos,
    dependencies,
    warnings,
    resolving,
    isLoading,
    refetch,
    add,
    addPaths,
    pickAndAdd,
    remove,
    install,
    resolve,
  } as const;
}
