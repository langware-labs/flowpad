import { Deployment, QueryRequest } from '@sdk';
import { useMemo } from 'react';
import { useEntitiesQuery } from '../entity-hooks';

/** Live Deployment entities used by runtime/status surfaces. */
export function useCurrentDeployments() {
  const request = useMemo(
    () => new QueryRequest({ type: Deployment.type, scope: [], name: 'useCurrentDeployments' }),
    [],
  );
  const result = useEntitiesQuery<Deployment>(request);
  return {
    ...result,
    data: result.data ?? [],
  };
}
