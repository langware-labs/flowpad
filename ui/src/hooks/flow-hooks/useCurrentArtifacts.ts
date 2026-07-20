import { Artifact, QueryRequest } from '@sdk';
import { useMemo } from 'react';
import { useEntitiesQuery } from '../entity-hooks';
import { useContext } from '../useContext';

/**
 * Hook to fetch all artifacts for the current project.
 * Queries artifacts by project so they persist across processes in the same
 * project. (The legacy Flow stream-artifact merge retired with the
 * conversational-Flow engine — the DB query is the single source.)
 */
export function useCurrentArtifacts() {
  const { project } = useContext();
  const projectTypeId = project?.typeId;

  const queryRequest = useMemo(
    () =>
      new QueryRequest({
        type: 'artifact',
        scope: projectTypeId ? [projectTypeId] : [],
        name: 'useCurrentArtifacts',
      }),
    [projectTypeId],
  );

  const {
    data: artifacts = [],
    isLoading,
    error,
  } = useEntitiesQuery<Artifact>(queryRequest, {
    enabled: !!projectTypeId,
  });

  // Newest first, deduped only by entity id. Artifacts with the same source or
  // kind may be distinct composition nodes and must remain visible.
  const sortedArtifacts = useMemo(() => {
    const dbArtifacts = artifacts;
    const uniqueArtifacts: Artifact[] = [];
    const seenIds = new Set<string>();

    for (const artifact of dbArtifacts) {
      if (artifact.id && seenIds.has(artifact.id)) continue;
      if (artifact.id) seenIds.add(artifact.id);
      uniqueArtifacts.push(artifact);
    }

    return uniqueArtifacts.sort((a, b) => {
      const aTime = new Date(a.created_date || 0).getTime();
      const bTime = new Date(b.created_date || 0).getTime();
      return bTime - aTime;
    });
  }, [artifacts]);

  return {
    data: sortedArtifacts,
    isLoading,
    error,
  };
}
