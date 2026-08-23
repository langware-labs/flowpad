import { AgenticProcess, ProcessKind, QueryFilter, QueryRequest } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { useMemo } from 'react';

/**
 * Subscribe to all AgenticProcesses keyed to a given VFS path.
 *
 * The attachment is stored on `AgenticProcess.target_typeid_str`. For
 * entity-scoped processes this is just `TypeId#toString()` (e.g. `agent-<id>`);
 * for surface-scoped processes it's a `<typeid>/<sub_path>` form (e.g.
 * `compute_node-<id>/Users/.../foo.md` for a per-doc process).
 *
 * When `processType` is supplied, filtering also constrains to processes whose
 * `process_type` matches (e.g. only `Chat` processes for the chat tab, only
 * `Execution` processes for Runs panels). The value is also folded into the
 * React-Query cache key so filtered/unfiltered subscribers don't share state.
 */
export function useProcessesForTarget(
  targetVfsPath: string | null | undefined,
  options?: { enabled?: boolean; processType?: ProcessKind; deploymentId?: string },
) {
  const key = targetVfsPath || '';
  const processType = options?.processType;
  const deploymentId = options?.deploymentId;
  const query = useMemo(() => {
    const match: Record<string, unknown> = { target_typeid_str: key };
    if (processType) match.process_type = processType;
    if (deploymentId) match.deployment_id = deploymentId;
    return new QueryRequest({
      type: AgenticProcess.type,
      scope: [],
      name: `processesForTarget:${key || 'none'}:${processType ?? 'any'}:${deploymentId ?? 'any-deployment'}`,
      query: new QueryFilter({ match }),
    });
  }, [deploymentId, key, processType]);

  const enabled = (options?.enabled ?? true) && !!key;
  const { data, isLoading, error } = useEntitiesQuery<AgenticProcess>(query, { enabled });

  return { processes: data ?? [], isLoading, error };
}
