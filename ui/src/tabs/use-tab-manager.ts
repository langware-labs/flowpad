import {
  childrenOfTab,
  dataContext,
  openTabHashes,
  openTabTargetIds,
  Project,
  projectTabCounts,
  tabManager,
  terminalTabsForScope,
  topLevelTabsForProject,
  type Tab,
  type TabLifecycleEntry,
  type TabScope,
} from '@sdk';
import { useContext } from '@sdk/react/hooks';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

/** Thin React subscription to the SDK's canonical, unscoped tab snapshot. */
export function useAllTabs(): readonly Tab[] {
  const tabs = useSyncExternalStore(tabManager.subscribe, tabManager.getSnapshot, tabManager.getSnapshot);
  useEffect(() => {
    tabManager.start();
  }, []);
  return tabs;
}

/** Top-level tabs in the requested project scope. An explicit null means Global. */
export function useCurrentTabs(projectId?: string | null): Tab[] {
  const tabs = useAllTabs();
  const { project } = useContext();
  const resolvedProjectId = projectId === undefined ? (project?.id ?? null) : projectId;
  return useMemo(
    () => topLevelTabsForProject(tabs, resolvedProjectId),
    [tabs, resolvedProjectId],
  );
}

export function useWorkspaceChildren(parentTabId: string | null | undefined): Tab[] {
  const tabs = useAllTabs();
  return useMemo(
    () => (parentTabId ? childrenOfTab(tabs, parentTabId) : []),
    [tabs, parentTabId],
  );
}

export function useTerminalTabs(
  scope: TabScope = 'project',
  projectId?: string | null,
): Tab[] {
  const tabs = useAllTabs();
  const resolvedProjectId = projectId === undefined ? (dataContext.project?.id ?? null) : projectId;
  return useMemo(
    () => terminalTabsForScope(tabs, scope, resolvedProjectId),
    [tabs, scope, resolvedProjectId],
  );
}

export function useOpenTabHashes(): Set<string> {
  const tabs = useAllTabs();
  return useMemo(() => openTabHashes(tabs), [tabs]);
}

export function useOpenTabTargetIds(): Set<string> {
  const tabs = useAllTabs();
  return useMemo(() => openTabTargetIds(tabs), [tabs]);
}

export function useTabLifecycle(key: string | null | undefined): TabLifecycleEntry | null {
  const lifecycles = useSyncExternalStore(
    tabManager.lifecycle.subscribe,
    tabManager.lifecycle.getSnapshot,
    tabManager.lifecycle.getSnapshot,
  );
  return key ? (lifecycles.get(key) ?? null) : null;
}

export function useTabLifecycles(): ReadonlyMap<string, TabLifecycleEntry> {
  return useSyncExternalStore(
    tabManager.lifecycle.subscribe,
    tabManager.lifecycle.getSnapshot,
    tabManager.lifecycle.getSnapshot,
  );
}

export type BucketState = 'loading' | 'live' | 'missing';

export interface TabProjectBucket {
  projectId: string;
  project: Project | null;
  state: BucketState;
  tabCount: number;
  recover: () => Promise<Project | null>;
}

export interface UseTabProjectBucketsResult {
  buckets: TabProjectBucket[];
  globalTabCount: number;
}

export function useTabProjectBuckets(): UseTabProjectBucketsResult {
  const tabs = useAllTabs();
  const { grouped, globalTabCount } = useMemo(() => {
    const { counts, globalTabCount: globalCount } = projectTabCounts(tabs);
    return { grouped: Array.from(counts.entries()), globalTabCount: globalCount };
  }, [tabs]);
  const [status, setStatus] = useState<ReadonlyMap<string, BucketState>>(() => new Map());

  useEffect(() => {
    const toCheck = grouped
      .map(([id]) => id)
      .filter((id) => {
        const known = status.get(id);
        return known !== 'live' && known !== 'missing';
      });
    if (toCheck.length === 0) return;
    let cancelled = false;
    void (async () => {
      const results = await Promise.all(
        toCheck.map(async (id): Promise<[string, BucketState]> => {
          const cached = Project.getByIdFromCache<Project>(id);
          if (cached) return [id, 'live'];
          const fetched = await Project.getById<Project>(id).catch(() => null);
          return [id, fetched ? 'live' : 'missing'];
        }),
      );
      if (cancelled) return;
      setStatus((previous) => {
        let changed = false;
        const next = new Map(previous);
        for (const [id, state] of results) {
          if (next.get(id) !== state) {
            next.set(id, state);
            changed = true;
          }
        }
        return changed ? next : previous;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [grouped, status]);

  const buckets = useMemo<TabProjectBucket[]>(
    () =>
      grouped.map(([projectId, tabCount]) => {
        const cached = Project.getByIdFromCache<Project>(projectId) ?? null;
        const resolved = status.get(projectId);
        const state: BucketState = cached ? 'live' : resolved === 'missing' ? 'missing' : 'loading';
        const project = state === 'live' ? cached : null;
        const recover = async (): Promise<Project | null> => {
          if (project) return project;
          const computeNodeId = dataContext.computeNode?.id;
          if (!computeNodeId) return null;
          const recovered = await Project.recoverOrphaned(projectId, computeNodeId).catch(() => null);
          if (!recovered) return null;
          setStatus((previous) => {
            const next = new Map(previous);
            next.delete(projectId);
            next.set(recovered.id, 'live');
            return next;
          });
          return recovered;
        };
        return { projectId, project, state, tabCount, recover };
      }),
    [grouped, status],
  );

  return { buckets, globalTabCount };
}

export function useSyncTranscriptTabName(
  tabHash: string | null | undefined,
  name: string | null | undefined,
): void {
  const tabs = useAllTabs();
  useEffect(() => {
    void tabManager.syncDockName(tabHash, name);
  }, [tabs, tabHash, name]);
}

export function useSyncContentTabNames(): void {
  useEffect(() => tabManager.attachContentEntitySync(), []);
}
