import { APIEntity, ApiError, dataManager, QueryRequest } from '@sdk';
import { useQuery, useQueryClient, UseQueryOptions } from '@tanstack/react-query';
import { useEffect } from 'react';

/**
 * Legacy version of useEntitiesQuery using TanStack React Query
 * @deprecated Use useEntitiesQuery instead (uses useSyncExternalStore)
 * This is kept as a backup version for reference
 */
export function useEntitiesQuery_reactQuery<T extends APIEntity<T>>(
  request: QueryRequest,
  queryOptions?: Omit<UseQueryOptions<T[], ApiError>, 'queryKey' | 'queryFn'>,
) {
  const queryJsonStringified = JSON.stringify(request.query);
  const scopeJsonStringified = JSON.stringify(request.scope?.filter((s) => s != null).map((s) => s.toString()) ?? []);

  const defaultQueryOptions = {
    structuralSharing: false,
  };

  const queryClient = useQueryClient();

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;

    const watchRequest = new QueryRequest({
      type: request.type,
      query: request.query,
      scope: request.scope?.filter((s) => s != null) || [],
      callback: (updatedEntities) => {
        const queryKey = ['entities_query', request.type, queryJsonStringified, scopeJsonStringified];
        // Update react-query cache when data manager receives updates
        queryClient.setQueryData(queryKey, updatedEntities);
        // Force invalidation to ensure re-render - this is the critical fix
        void queryClient.invalidateQueries({ queryKey });
      },
      name: request.name,
    });

    void dataManager.watchQuery<T>(watchRequest).then((unsub) => {
      unsubscribe = unsub;
    });

    return () => {
      if (unsubscribe) {
        unsubscribe();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.type, queryJsonStringified, scopeJsonStringified, queryClient, request.name]);

  const reactQueryKey = ['entities_query', request.type, queryJsonStringified, scopeJsonStringified];

  return useQuery<T[], ApiError>({
    queryKey: reactQueryKey,
    queryFn: async () => {
      return await dataManager.query<T>(request);
    },
    ...defaultQueryOptions,
    ...(queryOptions || {}),
  });
}
