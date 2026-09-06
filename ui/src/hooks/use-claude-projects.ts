import { useAgentContext } from '@src/contexts/agent-context';
import { fsManager, type ProjectListItem, type SkillItem } from '@sdk';
import { lazyAssets, LazyAsset } from '@sdk/lazy';
import { useLazyAsset } from '@sdk/react/hooks/useLazyAsset';
import { useCallback, useEffect } from 'react';
const NO_PROJECTS: ProjectListItem[] = [];
const NO_SKILLS: SkillItem[] = [];

export function useProjectList(options: { enabled?: boolean } = {}) {
  const { computeNode } = useAgentContext();
  const result = useLazyAsset(LazyAsset.DiscoveredProjects, { nodeId: computeNode?.id ?? '' }, {
    enabled: options.enabled !== false && !!computeNode?.id,
  });
  return { projects: result.data?.projects ?? NO_PROJECTS, totalCount: result.data?.total_count ?? 0,
    isLoading: result.isLoading, error: result.error?.message ?? null, refetch: result.reload };
}
export const useClaudeProjectList = useProjectList;

interface UseClaudeProjectResourcesOptions { includeSessions?: boolean; enabled?: boolean; pollInterval?: number }
export function useClaudeProjectResources(projectEncodedName: string | null, options: UseClaudeProjectResourcesOptions = {}) {
  const { computeNode } = useAgentContext();
  const { includeSessions = true, enabled = true, pollInterval = 0 } = options;
  const params = { nodeId: computeNode?.id ?? '', encodedName: projectEncodedName ?? '', includeSessions };
  const active = enabled && !!computeNode?.id && !!projectEncodedName;
  const result = useLazyAsset(LazyAsset.ProjectResources, params, { enabled: active });
  const reload = result.reload;
  useEffect(() => {
    if (!active || pollInterval <= 0) return;
    const id = setInterval(() => { void reload().catch(() => {}); }, pollInterval);
    return () => clearInterval(id);
  }, [active, pollInterval, reload]);
  return { data: result.data ?? null, isLoading: result.isLoading, error: result.error?.message ?? null,
    refetch: result.reload,
    invalidate: () => { void lazyAssets.client.invalidateQueries({
      queryKey: lazyAssets.key(LazyAsset.ProjectResources, params), exact: true, refetchType: 'none',
    }); },
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
 * Shares the node-scoped scan-item?type=skills read through LazyAsset.Skills.
 */
export function useAllSkills(options: { enabled?: boolean } = {}) {
  const { computeNode } = useAgentContext();
  const result = useLazyAsset(LazyAsset.Skills, { nodeId: computeNode?.id ?? '' }, {
    enabled: options.enabled !== false && !!computeNode?.id,
  });
  const reload = result.reload;
  const deleteSkill = useCallback(async (skill: SkillItem) => {
    const folder = skill.path || skill.source_file;
    if (!folder || !computeNode?.typeId) return;
    await fsManager.delete(computeNode.typeId, folder.replace(/\/[^/]+\.(md|yaml|yml)$/i, ''));
    await reload();
  }, [computeNode?.typeId, reload]);
  return { skills: result.data ?? NO_SKILLS, isLoading: result.isLoading, error: result.error,
    refetch: result.reload, deleteSkill };
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
