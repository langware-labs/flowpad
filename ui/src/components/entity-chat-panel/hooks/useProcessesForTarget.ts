import { AgenticProcess, QueryFilter, QueryRequest } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { useMemo } from 'react';

/**
 * Subscribe to all AgenticProcesses attached to a given target entity.
 *
 * The attachment is stored on `AgenticProcess.target_typeid_str` as a serialized
 * TypeId ("<type>-<id>"). Use `TypeId#toString()` on the host entity to build
 * `targetTypeIdStr`.
 */
export function useProcessesForTarget(
  targetTypeIdStr: string | null | undefined,
  options?: { enabled?: boolean },
) {
  const key = targetTypeIdStr || '';
  const query = useMemo(
    () => new QueryRequest({
      type: AgenticProcess.type,
      scope: [],
      name: `processesForTarget:${key || 'none'}`,
      query: new QueryFilter({ match: { target_typeid_str: key } as Record<string, unknown> }),
    }),
    [key],
  );

  const enabled = (options?.enabled ?? true) && !!key;
  const { data, isLoading, error } = useEntitiesQuery<AgenticProcess>(query, { enabled });

  return { processes: data ?? [], isLoading, error };
}
