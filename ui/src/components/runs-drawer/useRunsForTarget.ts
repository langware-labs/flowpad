import { QueryFilter, QueryRequest, Run } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { useMemo } from 'react';

/**
 * Subscribe to all Runs keyed to a given target_vfs_path.
 *
 * One Run per Approve & Execute (turn), regardless of process reuse — the
 * underlying AgenticProcess is shared across Runs to preserve Claude session
 * continuity, but each Run carries its own status so the drawer can show one
 * row per turn.
 */
export function useRunsForTarget(
  targetVfsPath: string | null | undefined,
  options?: { enabled?: boolean },
) {
  const key = targetVfsPath || '';
  const query = useMemo(
    () => new QueryRequest({
      type: Run.type,
      scope: [],
      name: `runsForTarget:${key || 'none'}`,
      query: new QueryFilter({ match: { target_vfs_path: key } as Record<string, unknown> }),
    }),
    [key],
  );

  const enabled = (options?.enabled ?? true) && !!key;
  const { data, isLoading, error } = useEntitiesQuery<Run>(query, { enabled });

  return { runs: data ?? [], isLoading, error };
}
