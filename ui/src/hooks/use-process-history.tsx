import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useAuth } from '@sdk/react/hooks';
import { Flow, QueryFilter, QueryRequest } from '@sdk';
import { useMemo } from 'react';

export const useProcessHistory = () => {
  const { someone } = useAuth();
  const { project } = useAgentContext();

  const flowsScope = useMemo(() => (project?.typeId ? [project.typeId] : []), [project?.typeId]);
  const flowsQuery = useMemo(() => {
    return project?.ImAnonymousViewer
      ? QueryFilter.parse({ updated_by: someone?.id, expand: ['auth_scopes'] }, Flow.type)
      : QueryFilter.parse({ expand: ['auth_scopes'] }, Flow.type);
  }, [someone?.id, project?.ImAnonymousViewer]);

  const request = useMemo(
    () =>
      new QueryRequest({
        type: Flow.type,
        scope: flowsScope,
        query: flowsQuery,
        name: 'useProcessHistory',
      }),
    [flowsScope, flowsQuery],
  );

  return useEntitiesQuery<Flow>(request);
};
