import { EntityEnv, TypeId, EntityEnvVars } from '@sdk';
import { useQuery, useQueryClient } from '@tanstack/react-query';

export interface UseEntityEnvOptions {
  /**
   * The entity (user, project, etc.) to fetch environment variables for
   */
  entityTypeId?: TypeId;

  /**
   * Whether to automatically fetch data. Defaults to true if entityTypeId is provided.
   */
  enabled?: boolean;

  /**
   * Refetch interval in milliseconds. Set to false to disable auto-refetch.
   */
  refetchInterval?: number | false;
}

export interface UseEntityEnvReturn {
  /**
   * The environment variables table data
   */
  table: EntityEnvVars | undefined;

  /**
   * Whether the initial fetch is in progress
   */
  isLoading: boolean;

  /**
   * Whether a background refetch is in progress
   */
  isFetching: boolean;

  /**
   * Any error that occurred during fetch
   */
  error: Error | null;

  /**
   * Manually trigger a refetch
   */
  refetch: () => Promise<unknown>;

  /**
   * The entity TypeId this hook is tracking
   */
  entityTypeId: TypeId | undefined;
}

/**
 * Hook to fetch and manage environment variables for an entity.
 *
 * This hook provides a unified interface for both the Connections tab (user entity)
 * and the Environment tab (project entity).
 *
 * Features:
 * - Automatic caching and deduplication via React Query
 * - Loading and error states
 * - Manual refetch capability
 * - Auto-refetch on window focus
 * - Stale-while-revalidate behavior
 *
 * @example
 * // For Connections tab (user entity)
 * const { table, isLoading } = useEntityEnv({ entityTypeId: userTypeId });
 * const providers = table?.values.filter(v => v.var_type === 'oauth_provider');
 *
 * @example
 * // For Environment tab (project entity)
 * const { table, isLoading, refetch } = useEntityEnv({ entityTypeId: projectTypeId });
 * const envVars = table?.values || [];
 */
/**
 * The react-query key for an entity's env table.
 *
 * Every module that reads, writes, or invalidates that cache entry goes
 * through here — `useEntityEnv` (reader), `useEntityEnvMutations` (writer),
 * and `useOAuthConnection`, which invalidates it after an attach or detach.
 * The key was hand-written in a dozen places, so a rename could only ever be
 * done by grep.
 */
export const entityEnvQueryKey = (entityTypeId?: TypeId) => ['entity-env-table', entityTypeId?.toString()] as const;

export const useEntityEnv = (options: UseEntityEnvOptions = {}): UseEntityEnvReturn => {
  const { entityTypeId, enabled = true, refetchInterval } = options;
  const queryClient = useQueryClient();

  const query = useQuery<EntityEnvVars>({
    queryKey: entityEnvQueryKey(entityTypeId),
    queryFn: async () => {
      if (!entityTypeId) {
        throw new Error('Entity TypeId is required');
      }

      const entityEnv = new EntityEnv(entityTypeId);
      const tableData = await entityEnv.getTable();

      // Ensure we always return a valid EntityEnvVars, never undefined
      if (!tableData) {
        return { values: [] };
      }

      return tableData;
    },
    enabled: enabled && !!entityTypeId,
    staleTime: 30000, // Consider data fresh for 30s to prevent excessive refetches
    refetchInterval: refetchInterval,
    retry: 1, // Retry once on failure
    // Return cached data if available to prevent empty state flash
    initialData: () => {
      const cached = queryClient.getQueryData<EntityEnvVars>(entityEnvQueryKey(entityTypeId));
      return cached;
    },
  });

  return {
    table: query.data,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refetch: query.refetch,
    entityTypeId,
  };
};
