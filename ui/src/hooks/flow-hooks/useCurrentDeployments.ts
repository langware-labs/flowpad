import { Deployment, QueryRequest } from '@sdk';
import { useMemo } from 'react';
import { useEntitiesQuery } from '../entity-hooks';
import { useContext } from '../useContext';

/**
 * Every placement in the CURRENT project.
 *
 * Project-scoped, like its `useCurrentArtifacts` sibling. The name always said
 * "current", but the query passed an empty scope and returned every deployment
 * on the machine — invisible while the only rows were this project's dev
 * servers, and wrong now that one entity also covers agent sandboxes and cloud
 * desktops.
 */
export function useCurrentDeployments() {
  const { project } = useContext();
  const projectTypeId = project?.typeId;

  const request = useMemo(
    () =>
      new QueryRequest({
        type: Deployment.type,
        scope: projectTypeId ? [projectTypeId] : [],
        name: 'useCurrentDeployments',
      }),
    [projectTypeId],
  );
  const result = useEntitiesQuery<Deployment>(request, { enabled: !!projectTypeId });
  return {
    ...result,
    data: result.data ?? [],
    project,
  };
}
