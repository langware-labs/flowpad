import { Artifact, IArtifact } from '@sdk';
import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useProject } from '../useProject';

export interface UseArtifactActionsReturn {
  /** Add a new artifact to the project */
  addArtifact: (artifactData: Partial<IArtifact>) => Promise<Artifact>;
  /** Delete an artifact by ID */
  deleteArtifact: (artifactId: string) => Promise<boolean>;
  /** Loading state for add operation */
  isAdding: boolean;
  /** Loading state for delete operation */
  isDeleting: boolean;
  /** Error from last operation */
  error: Error | null;
}

/**
 * Hook for artifact CRUD operations using the Project entity methods.
 * Provides add and delete functionality with loading states and error handling.
 */
export function useArtifactActions(): UseArtifactActionsReturn {
  const { project } = useProject();
  const queryClient = useQueryClient();
  const [isAdding, setIsAdding] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const invalidateArtifacts = useCallback(() => {
    // Invalidate artifact queries to trigger refetch
    void queryClient.invalidateQueries({ queryKey: ['entities', 'artifact'] });
  }, [queryClient]);

  const addArtifact = useCallback(
    async (artifactData: Partial<IArtifact>): Promise<Artifact> => {
      if (!project) {
        throw new Error('Project is not available');
      }

      setIsAdding(true);
      setError(null);

      try {
        const artifact = await project.addArtifact(artifactData);
        invalidateArtifacts();
        return artifact;
      } catch (err) {
        const error = err instanceof Error ? err : new Error('Failed to add artifact');
        setError(error);
        throw error;
      } finally {
        setIsAdding(false);
      }
    },
    [project, invalidateArtifacts],
  );

  const deleteArtifact = useCallback(
    async (artifactId: string): Promise<boolean> => {
      if (!project) {
        throw new Error('Project is not available');
      }

      setIsDeleting(true);
      setError(null);

      try {
        const result = await project.deleteArtifact(artifactId);
        invalidateArtifacts();
        return result;
      } catch (err) {
        const error = err instanceof Error ? err : new Error('Failed to delete artifact');
        setError(error);
        throw error;
      } finally {
        setIsDeleting(false);
      }
    },
    [project, invalidateArtifacts],
  );

  return {
    addArtifact,
    deleteArtifact,
    isAdding,
    isDeleting,
    error,
  };
}
