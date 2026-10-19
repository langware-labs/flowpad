import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  dataContext,
  onProjectDependenciesChanged,
  onProjectLoadChanged,
  type DependencyState,
  type Project,
  type ProjectContextDirInfo,
} from '@sdk';

/** Whether a package about to be added is local (this device only, recorded in no
 *  project file), required (fetched automatically) or optional (fetched only on Install). */
export type DependencyKind = 'local' | 'required' | 'optional';

interface UseProjectDependenciesOptions {
  /** Read/write this asset's own flow.json rather than the project declaration. */
  asset?: string;
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
  { fetchStates = true, asset }: UseProjectDependenciesOptions = {},
) {
  const projectRef = useRef<Project | null>(null);
  projectRef.current = project ?? null;
  const assetRef = useRef(asset);
  assetRef.current = asset;

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
  const [error, setError] = useState('');
  // Discards a stale response when the project changes mid-flight (same
  // tick-guard as useProjectAssetMenu).
  const tickRef = useRef(0);
  const scopeKey = `${project?.id ?? ''}:${asset ?? ''}`;
  const scopeRef = useRef(scopeKey);
  if (scopeRef.current !== scopeKey) {
    scopeRef.current = scopeKey;
    tickRef.current += 1;
  }
  const [loadedScope, setLoadedScope] = useState(scopeKey);

  const refetch = useCallback(async () => {
    const p = projectRef.current;
    const requestedScope = scopeRef.current;
    const tick = ++tickRef.current;
    if (!p) {
      setDependencies([]);
      setWarnings([]);
      setResolving(false);
      setIsLoading(false);
      setError('');
      setLoadedScope(requestedScope);
      return;
    }
    setIsLoading(true);
    setError('');
    try {
      const next = await (assetRef.current ? p.dependencies({ asset: assetRef.current }) : p.dependencies());
      if (tickRef.current !== tick) return;
      setDependencies(next.dependencies);
      setWarnings(next.warnings);
      setResolving(next.resolving);
      setLoadedScope(requestedScope);
    } catch (err) {
      if (tickRef.current !== tick) return;
      setError(err instanceof Error ? err.message : String(err));
      setDependencies([]);
      setWarnings([]);
      setResolving(false);
      setLoadedScope(requestedScope);
      console.error('[useProjectDependencies] failed', err);
    } finally {
      if (tickRef.current === tick) setIsLoading(false);
    }
  }, []);

  const projectId = project?.id ?? null;
  useEffect(() => {
    if (fetchStates) void refetch();
  }, [fetchStates, projectId, asset, contextDirsKey, contextDirInfosKey, refetch]);

  useEffect(() => {
    if (!fetchStates || !projectId) return;
    return onProjectDependenciesChanged(projectId, () => void refetch());
  }, [fetchStates, projectId, refetch]);

  useEffect(() => {
    if (!fetchStates) return;
    return onProjectLoadChanged(() => void refetch());
  }, [fetchStates, refetch]);

  /** Declare a dependency. `source` is anything `add-dependency` takes — a
   *  `git+…` / `hub:…` / `file:…` source, a local folder or a bare git URL.
   *  Rejects with the backend's message on a bad source. */
  const add = useCallback(
    async (source: string, kind: DependencyKind = 'local', options: { name?: string; path?: string } = {}) => {
      const p = projectRef.current;
      if (!p) return null;
      return p.addDependency(source, { ...options, optional: kind === 'optional', ...(assetRef.current ? { asset: assetRef.current } : { local: kind === 'local' }) });
    },
    [],
  );

  /** Add each given absolute folder path as a dependency. */
  const addPaths = useCallback(
    async (paths: string[], kind: DependencyKind = 'local') => {
      for (const path of paths) {
        if (path) await add(path, kind);
      }
    },
    [add],
  );

  /** Native folder picker → add. No-op without a compute node. */
  const pickAndAdd = useCallback(
    async (kind: DependencyKind = 'local') => {
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
      if (assetRef.current) await p.removeDependency(name, { asset: assetRef.current });
      else await p.removeDependency(name);
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
    dependencies: loadedScope === scopeKey ? dependencies : [],
    warnings: loadedScope === scopeKey ? warnings : [],
    error: loadedScope === scopeKey ? error : '',
    resolving: loadedScope === scopeKey && resolving,
    isLoading: isLoading || (fetchStates && !!project && loadedScope !== scopeKey),
    refetch,
    add,
    addPaths,
    pickAndAdd,
    remove,
    install,
    resolve,
  } as const;
}
