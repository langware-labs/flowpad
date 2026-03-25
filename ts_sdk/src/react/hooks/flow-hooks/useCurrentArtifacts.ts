import { Artifact, CodeRef, QueryRequest } from '@sdk';
import { useMemo } from 'react';
import { useEntitiesQuery } from '../entity-hooks';
import { useContext } from '../useContext';
import { useProcessStreamingArtifacts } from './useProcessStreamingArtifacts';

/**
 * Hook to fetch all artifacts for the current project
 * Queries artifacts by project to persist across flows in the same project
 * Also includes streaming artifacts from the current flow via useProcessStreamingArtifacts
 *
 * @param flow - Flow object from which projectTypeId will be extracted
 */
export function useCurrentArtifacts() {
  const { flow, project } = useContext();
  const projectTypeId = project?.typeId;

  const queryRequest = new QueryRequest({
    type: 'artifact',
    scope: projectTypeId ? [projectTypeId] : [],
    name: 'useCurrentArtifacts',
  });

  const {
    data: artifacts = [],
    isLoading,
    error,
  } = useEntitiesQuery<CodeRef>(queryRequest, {
    enabled: !!projectTypeId,
  });

  // Get streaming artifacts from the current flow's stream
  const { artifacts: flowStreamingArtifacts } = useProcessStreamingArtifacts(flow);

  // Combine artifacts from database and flow stream, removing duplicates
  // Artifacts are considered duplicates if they have same id, same path (non-empty), or same port
  const combinedArtifacts = useMemo(() => {
    const dbArtifacts = artifacts as Artifact[];
    const uniqueArtifacts: Artifact[] = [];
    const seenKeys = new Set<string>();

    // Helper function to generate keys for an artifact based on id, path, and port
    const getArtifactKeys = (artifact: Artifact): string[] => {
      const keys: string[] = [];
      // Add id key if available
      if (artifact.id) {
        keys.push(`id:${artifact.id}`);
      }
      // Add path key if it's not null, undefined, or empty
      if (artifact.path && artifact.path.trim() !== '') {
        keys.push(`path:${artifact.path}`);
      }
      // Add port key if available
      const port = artifact.port ?? artifact.metadata?.port;
      if (port !== null && port !== undefined && port !== '') {
        // Ensure port is a primitive value (string or number) before stringifying
        const portValue = typeof port === 'string' || typeof port === 'number' ? String(port) : null;
        if (portValue) {
          keys.push(`port:${portValue}`);
        }
      }
      return keys;
    };

    // Helper function to check if artifact is a duplicate
    const isDuplicate = (artifact: Artifact): boolean => {
      const keys = getArtifactKeys(artifact);
      if (keys.length === 0) {
        return false; // No identifying keys, can't be a duplicate
      }
      return keys.some((key) => seenKeys.has(key));
    };

    // Helper function to mark artifact keys as seen
    const markAsSeen = (artifact: Artifact): void => {
      const keys = getArtifactKeys(artifact);
      keys.forEach((key) => seenKeys.add(key));
    };

    // Add database and flow streaming artifacts that aren't already seen
    for (const artifact of [...dbArtifacts, ...flowStreamingArtifacts]) {
      if (!isDuplicate(artifact)) {
        markAsSeen(artifact);
        uniqueArtifacts.push(artifact);
      }
    }

    // Sort unique artifacts by created_date in descending order (newest first)
    return uniqueArtifacts.sort((a, b) => {
      const aTime = new Date(a.created_date || 0).getTime();
      const bTime = new Date(b.created_date || 0).getTime();
      return bTime - aTime; // Descending order (newest first)
    });
  }, [artifacts, flowStreamingArtifacts]);

  return {
    data: combinedArtifacts,
    isLoading,
    error,
  };
}
