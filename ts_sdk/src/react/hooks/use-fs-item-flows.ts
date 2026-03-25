import { Flow, FSItem, Project, QueryFilter, QueryRequest, VFSPath } from '@sdk';
import { useEntitiesQuery } from './entity-hooks';
import { useProject } from './useProject';
import { useMemo } from 'react';

export interface UseFSItemFlowsOptions {
  enabled?: boolean;
  /** Optional project override for testing. If not provided, uses useProject() context. */
  project?: Project | null;
}

/**
 * Normalize VFS path to use @local uname format for consistent querying.
 * Converts paths like "compute_node-{uuid}/path" to "compute_node-@local/path"
 */
export function normalizeVfsPathToLocal(vfsAbsPath: string | null | undefined): string | null {
  if (!vfsAbsPath) return null;

  const vfsPath = VFSPath.parse(vfsAbsPath);
  if (!vfsPath.type || !vfsPath.entitySubPath) {
    return vfsAbsPath; // Return as-is if can't parse
  }

  // Always use @local for compute_node type to ensure consistent matching
  if (vfsPath.type === 'compute_node') {
    return `compute_node-@local/${vfsPath.entitySubPath}`;
  }

  // For other types, use the original path
  return vfsAbsPath;
}

/**
 * Hook to query flows associated with a specific FSItem.
 * Uses the FSItem's vfs_abs_path normalized to @local uname format for consistent querying.
 *
 * @param item - The FSItem to query flows for (can be null/undefined)
 * @param options - Query options (enabled, project override)
 * @returns Query result with flows array, loading state, error, and refetch function
 */
export function useFSItemFlows(item: FSItem | null | undefined, options: UseFSItemFlowsOptions = {}) {
  const { enabled = true, project: projectOverride } = options;
  const { project: contextProject } = useProject();
  const project = projectOverride !== undefined ? projectOverride : contextProject;

  // Normalize the VFS path to use @local uname format
  const normalizedVfsPath = useMemo(() => {
    return normalizeVfsPathToLocal(item?.vfs_abs_path);
  }, [item?.vfs_abs_path]);

  // Build query scope from project
  const flowsScope = useMemo(() => (project?.typeId ? [project.typeId] : []), [project?.typeId]);

  // Determine if we should enable the query
  const shouldFetch = enabled && !!normalizedVfsPath && flowsScope.length > 0;

  // Build the query filter
  // Note: Don't expand auth_scopes - not supported on Flow entity
  const flowsQuery = useMemo(() => {
    return QueryFilter.parse(
      {
        match: { source_vfs_path: normalizedVfsPath || '' },
      },
      Flow.type,
    );
  }, [normalizedVfsPath]);

  // Build the query request
  const request = useMemo(() => {
    return new QueryRequest({
      type: Flow.type,
      scope: flowsScope.length > 0 ? flowsScope : [],
      query: flowsQuery,
      name: 'useFSItemFlows',
    });
  }, [flowsScope, flowsQuery]);

  // Execute the query
  const {
    data: flows = [],
    isLoading,
    error,
    refetch,
  } = useEntitiesQuery<Flow>(request, {
    enabled: shouldFetch,
  });

  return {
    flows,
    isLoading,
    error,
    refetch,
    // Expose normalized path for debugging
    normalizedVfsPath,
  };
}
