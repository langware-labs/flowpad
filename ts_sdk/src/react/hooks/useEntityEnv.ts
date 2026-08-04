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

/**
 * The prefix every entity's env-table key starts with — for invalidating the
 * whole family at once. Deleting a user's credential changes the resolved status
 * on EVERY project that borrowed it, and the caller does not know which those
 * are; invalidating one project's key would leave the others showing a
 * credential that no longer exists.
 */
export const entityEnvQueryKeyRoot = ['entity-env-table'] as const;

/** Freshness for that cache entry. Exported because the connections table's
 *  usage fan-out registers queries on the SAME key — two owners of one entry's
 *  staleness would refetch on different schedules depending on which mounted
 *  first. */
export const ENTITY_ENV_STALE_MS = 30000;

/**
 * The queryFn behind {@link useEntityEnv}, exported so callers that fan out over
 * many entities (the connections table asking "which projects use this
 * credential?") can register `useQueries` entries that land on the SAME cache
 * entry — same key, same fetcher — instead of a parallel cache that misses every
 * invalidation the mutation paths already do.
 */
export const fetchEntityEnvTable = async (entityTypeId?: TypeId): Promise<EntityEnvVars> => {
  if (!entityTypeId) {
    throw new Error('Entity TypeId is required');
  }
  const entityEnv = new EntityEnv(entityTypeId);
  return (await entityEnv.getTable()) ?? { values: [] };
};

export const useEntityEnv = (options: UseEntityEnvOptions = {}): UseEntityEnvReturn => {
  const { entityTypeId, enabled = true, refetchInterval } = options;
  const queryClient = useQueryClient();

  const query = useQuery<EntityEnvVars>({
    queryKey: entityEnvQueryKey(entityTypeId),
    queryFn: () => fetchEntityEnvTable(entityTypeId),
    enabled: enabled && !!entityTypeId,
    staleTime: ENTITY_ENV_STALE_MS,
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
