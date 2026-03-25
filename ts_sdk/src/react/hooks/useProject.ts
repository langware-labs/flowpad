import { Project, TypeId } from '@sdk';
import { useCallback, useMemo } from 'react';
import { useEntity } from './entity-hooks';
import { useContext } from './useContext';

export function useProject(projectTypeId?: TypeId | null, options?: Parameters<typeof useEntity<Project>>[1]) {
  const context = useContext();
  const effectiveProjectTypeId = useMemo(() => {
    if (projectTypeId) return projectTypeId;
    return context.project?.typeId ?? null;
  }, [projectTypeId, context.project?.typeId]);
  const { data: project, isLoading, error } = useEntity<Project>(effectiveProjectTypeId, { watch: true, ...options });

  const setupComputeNode = useCallback(
    async (options?: { gitRemoteRepoUrl?: string; gitBranch?: string }) => {
      if (!project) {
        throw new Error('Project is not available');
      }
      await project.setupComputeNode(options);
    },
    [project],
  );

  return {
    project: project,
    isLoading: isLoading,
    error: error,
    setupComputeNode,
  };
}
