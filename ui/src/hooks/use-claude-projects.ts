import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import {
  fetchAllSkillsFromComputeNode,
  fsManager,
  listProjectsFromComputeNode,
  scanProjectFromComputeNode,
  type ListProjectsResponse,
  type ProjectListItem,
  type ScanProjectResponse,
  type SkillItem,
} from '@sdk';
import { useCallback, useEffect, useRef, useState } from 'react';

/** Cache TTL in milliseconds (2 minutes for project list, longer since it changes less often) */
const PROJECT_LIST_CACHE_TTL = 120000;

/** Cache TTL for per-project resources (1 minute) */
const PROJECT_RESOURCES_CACHE_TTL = 60000;

interface ProjectResourcesCache {
  data: ScanProjectResponse;
  timestamp: number;
}

interface UseProjectListOptions {
  enabled?: boolean;
}

interface ProjectListCache {
  data: ListProjectsResponse;
  timestamp: number;
}

const projectListCache = new Map<string, ProjectListCache>();
const projectListInFlight = new Map<string, Promise<ListProjectsResponse>>();

const projectResourcesCache = new Map<string, ProjectResourcesCache>();
const projectResourcesInFlight = new Map<string, Promise<ScanProjectResponse>>();

/**
 * Hook for fast project list enumeration.
 * The backend merges Claude, Codex, Copilot, and persisted Project entities.
 * Returns just the project list (~50ms) without loading all resources.
 */
export function useProjectList(options: UseProjectListOptions = {}) {
  const { computeNode } = useAgentContext();
  const { enabled = true } = options;

  // Initialize from module-level cache to avoid flash on remount
  const [data, setData] = useState<ListProjectsResponse | null>(() => {
    if (!computeNode?.id) return null;
    const cached = projectListCache.get(computeNode.id);
    if (cached && Date.now() - cached.timestamp < PROJECT_LIST_CACHE_TTL) {
      return cached.data;
    }
    return null;
  });
  const [isLoading, setIsLoading] = useState(() => {
    if (!enabled) return false;
    if (!computeNode?.id) return true;
    const cached = projectListCache.get(computeNode.id);
    return !cached || Date.now() - cached.timestamp >= PROJECT_LIST_CACHE_TTL;
  });
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(
    async (forceRefresh = false) => {
      if (!enabled) {
        setIsLoading(false);
        return;
      }

      if (!computeNode?.id) {
        setIsLoading(false);
        setError('No compute node available');
        return;
      }

      const cacheKey = computeNode.id;

      // Check cache
      if (!forceRefresh) {
        const cached = projectListCache.get(cacheKey);
        const age = cached ? Date.now() - cached.timestamp : Number.POSITIVE_INFINITY;
        if (age < PROJECT_LIST_CACHE_TTL) {
          setData(cached!.data);
          setIsLoading(false);
          return;
        }
      }

      setIsLoading(true);
      setError(null);

      try {
        let pending = projectListInFlight.get(cacheKey);
        if (!pending || forceRefresh) {
          pending = listProjectsFromComputeNode(computeNode.id);
          projectListInFlight.set(cacheKey, pending);
        }

        const result = await pending;
        setData(result);
        projectListCache.set(cacheKey, { data: result, timestamp: Date.now() });
      } catch (err) {
        console.error('Failed to list projects:', err);
        setError(err instanceof Error ? err.message : 'Failed to list projects');
      } finally {
        projectListInFlight.delete(cacheKey);
        setIsLoading(false);
      }
    },
    [computeNode?.id, enabled],
  );

  useEffect(() => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }
    void fetchData();
  }, [enabled, fetchData]);

  return {
    projects: data?.projects ?? [],
    totalCount: data?.total_count ?? 0,
    isLoading,
    error,
    refetch: () => fetchData(true),
  };
}

/** @deprecated Use useProjectList. */
export const useClaudeProjectList = useProjectList;

/**
 * Hook for loading resources for a specific Claude Code project.
 * Only loads when a project is selected (lazy loading).
 */
interface UseClaudeProjectResourcesOptions {
  includeSessions?: boolean;
  enabled?: boolean;
  /** Auto-refresh interval in milliseconds (0 = disabled) */
  pollInterval?: number;
}

export function useClaudeProjectResources(
  projectEncodedName: string | null,
  options: UseClaudeProjectResourcesOptions = {},
) {
  const { computeNode } = useAgentContext();
  const { includeSessions = true, enabled = true, pollInterval = 0 } = options;

  // Initialize state from module-level cache to avoid flash on remount
  const [data, setData] = useState<ScanProjectResponse | null>(() => {
    if (!computeNode?.id || !projectEncodedName) return null;
    const sessionsKey = includeSessions ? 'with_sessions' : 'without_sessions';
    const cacheKey = `${computeNode.id}:${projectEncodedName}:${sessionsKey}`;
    const cached = projectResourcesCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < PROJECT_RESOURCES_CACHE_TTL) {
      return cached.data;
    }
    return null;
  });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Per-project cache
  const cacheRef = useRef<Map<string, ProjectResourcesCache>>(new Map());

  const fetchData = useCallback(
    async (forceRefresh = false) => {
      if (!enabled) {
        setIsLoading(false);
        return;
      }

      if (!computeNode?.id || !projectEncodedName) {
        setIsLoading(false);
        setData(null);
        return;
      }

      const sessionsKey = includeSessions ? 'with_sessions' : 'without_sessions';
      const cacheKey = `${computeNode.id}:${projectEncodedName}:${sessionsKey}`;
      const cacheRefKey = `${projectEncodedName}:${sessionsKey}`;

      // Check cache
      if (!forceRefresh) {
        const cached = projectResourcesCache.get(cacheKey) || cacheRef.current.get(cacheRefKey);
        if (cached) {
          const age = Date.now() - cached.timestamp;
          if (age < PROJECT_RESOURCES_CACHE_TTL) {
            setData(cached.data);
            setIsLoading(false);
            return;
          }
        }
      }

      setIsLoading(true);
      setError(null);

      try {
        let pending = projectResourcesInFlight.get(cacheKey);
        if (!pending || forceRefresh) {
          pending = scanProjectFromComputeNode(computeNode.id, projectEncodedName, 100, includeSessions);
          projectResourcesInFlight.set(cacheKey, pending);
        }

        const result = await pending;
        setData(result);
        projectResourcesCache.set(cacheKey, { data: result, timestamp: Date.now() });
        cacheRef.current.set(cacheRefKey, { data: result, timestamp: Date.now() });
      } catch (err) {
        console.error('Failed to scan Claude project:', err);
        setError(err instanceof Error ? err.message : 'Failed to scan project');
      } finally {
        projectResourcesInFlight.delete(cacheKey);
        setIsLoading(false);
      }
    },
    [computeNode?.id, enabled, includeSessions, projectEncodedName],
  );

  useEffect(() => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }
    void fetchData();
  }, [enabled, fetchData]);

  // Auto-refresh polling
  useEffect(() => {
    if (!enabled || !pollInterval || pollInterval <= 0) return;
    const id = setInterval(() => void fetchData(true), pollInterval);
    return () => clearInterval(id);
  }, [enabled, pollInterval, fetchData]);

  return {
    data,
    isLoading,
    error,
    refetch: () => fetchData(true),
    invalidate: () => {
      if (projectEncodedName) {
        const sessionsKey = includeSessions ? 'with_sessions' : 'without_sessions';
        if (computeNode?.id) {
          projectResourcesCache.delete(`${computeNode.id}:${projectEncodedName}:${sessionsKey}`);
        }
        cacheRef.current.delete(`${projectEncodedName}:${sessionsKey}`);
      }
    },
  };
}

/**
 * Combined hook that provides both project list and selected project resources.
 * This is the main hook to use for the Projects tab UI.
 */
export function useClaudeProjects(selectedProjectEncodedName: string | null = null) {
  const projectList = useProjectList();
  const projectResources = useClaudeProjectResources(selectedProjectEncodedName);

  return {
    // Project list (fast, ~50ms)
    projects: projectList.projects,
    totalCount: projectList.totalCount,
    isLoadingProjects: projectList.isLoading,
    projectsError: projectList.error,
    refetchProjects: projectList.refetch,

    // Selected project resources (lazy, ~100ms when selected)
    selectedProject: projectResources.data,
    isLoadingResources: projectResources.isLoading,
    resourcesError: projectResources.error,
    refetchResources: projectResources.refetch,
    invalidateResources: projectResources.invalidate,
  };
}

/**
 * Hook to fetch all skills across user-level and all projects.
 * Uses the scan-item?type=skills endpoint. No cache — the scan is fast (~100ms).
 */
export function useAllSkills(options: { enabled?: boolean } = {}) {
  const { computeNode } = useAgentContext();
  const { enabled = true } = options;
  const [data, setData] = useState<SkillItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const fetchData = useCallback(async () => {
    if (!enabled || !computeNode?.id) {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    try {
      const result = await fetchAllSkillsFromComputeNode(computeNode.id);
      setData(result);
    } catch (err) {
      console.error('Failed to fetch all skills:', err);
    } finally {
      setIsLoading(false);
    }
  }, [computeNode?.id, enabled]);

  useEffect(() => {
    if (!enabled) return;
    void fetchData();
  }, [enabled, fetchData]);

  const deleteSkill = useCallback(
    async (skill: SkillItem) => {
      const folder = skill.path || skill.source_file;
      if (!folder || !computeNode?.typeId) return;
      // Optimistic: remove from UI immediately
      if (skill.id) setData((prev) => prev.filter((s) => s.id !== skill.id));
      // Resolve parent folder (path may point to skill.md inside the folder)
      const dir = folder.replace(/\/[^/]+\.(md|yaml|yml)$/i, '');
      await fsManager.delete(computeNode.typeId, dir);
      await fetchData();
    },
    [computeNode?.typeId, fetchData],
  );

  return {
    skills: data,
    isLoading,
    refetch: fetchData,
    deleteSkill,
  };
}

/**
 * Get a display name for a Claude Code project.
 * Converts encoded names like "-Users-alice-Documents-dev-test" to "~/Documents/dev/test"
 */
export function getProjectDisplayName(project: ProjectListItem): string {
  // Use the last folder name from cwd
  if (project.cwd) {
    const trimmed = project.cwd.replace(/\/+$/, '');
    const lastSlash = trimmed.lastIndexOf('/');
    if (lastSlash >= 0) {
      return trimmed.substring(lastSlash + 1);
    }
    return trimmed;
  }

  // Use the name field if available and not just the encoded name
  if (project.name && project.name !== project.encoded_name) {
    return project.name;
  }

  // Fallback: decode the encoded name and take last segment
  const decoded = project.encoded_name.replace(/-/g, '/').replace(/^\/+/, '');
  const lastSlash = decoded.lastIndexOf('/');
  return lastSlash >= 0 ? decoded.substring(lastSlash + 1) : decoded;
}
