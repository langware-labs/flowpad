import { Artifact, CodeRef, QueryRequest } from '@sdk';
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
  } = useEntitiesQuery<CodeRef>(queryRequest, {
    enabled: !!projectTypeId,
  });

  // Newest first, deduped by id/path/port (DB rows can transiently double up
  // when a port-bearing artifact is re-emitted).
  const sortedArtifacts = useMemo(() => {
    const dbArtifacts = artifacts as Artifact[];
    const uniqueArtifacts: Artifact[] = [];
    const seenKeys = new Set<string>();

    const getArtifactKeys = (artifact: Artifact): string[] => {
      const keys: string[] = [];
      if (artifact.id) keys.push(`id:${artifact.id}`);
      if (artifact.path && artifact.path.trim() !== '') keys.push(`path:${artifact.path}`);
      const port = artifact.port ?? artifact.metadata?.port;
      if (port !== null && port !== undefined && port !== '') {
        const portValue = typeof port === 'string' || typeof port === 'number' ? String(port) : null;
        if (portValue) keys.push(`port:${portValue}`);
      }
      return keys;
    };

    for (const artifact of dbArtifacts) {
      const keys = getArtifactKeys(artifact);
      if (keys.length > 0 && keys.some((key) => seenKeys.has(key))) continue;
      keys.forEach((key) => seenKeys.add(key));
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
