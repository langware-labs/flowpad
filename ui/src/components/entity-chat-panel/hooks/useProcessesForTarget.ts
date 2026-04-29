import { AgenticProcess, QueryFilter, QueryRequest } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { useMemo } from 'react';

/**
 * Subscribe to all AgenticProcesses keyed to a given VFS path.
 *
 * The attachment is stored on `AgenticProcess.target_vfs_path`. For
 * entity-scoped chats this is just `TypeId#toString()` (e.g. `agent-<id>`);
 * for surface-scoped chats it's a `<typeid>/<sub_path>` form (e.g.
 * `compute_node-<id>/Users/.../foo.md` for a per-doc chat).
 */
export function useProcessesForTarget(
  targetVfsPath: string | null | undefined,
  options?: { enabled?: boolean },
) {
  const key = targetVfsPath || '';
  const query = useMemo(
    () => new QueryRequest({
      type: AgenticProcess.type,
      scope: [],
      name: `processesForTarget:${key || 'none'}`,
      query: new QueryFilter({ match: { target_vfs_path: key } as Record<string, unknown> }),
    }),
    [key],
  );

  const enabled = (options?.enabled ?? true) && !!key;
  const { data, isLoading, error } = useEntitiesQuery<AgenticProcess>(query, { enabled });

  return { processes: data ?? [], isLoading, error };
}
