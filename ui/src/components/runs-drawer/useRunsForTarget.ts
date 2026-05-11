import { QueryFilter, QueryRequest, Run } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { useMemo } from 'react';

/**
 * Subscribe to Runs keyed to a target_vfs_path, optionally narrowed to those
 * triggered by a specific source FlowMessage. One Run per Approve & Execute.
 *
 * The underlying AgenticProcess is shared across Runs to preserve Claude
 * session continuity, but each Run carries its own status + the FlowMessage
 * id whose PROMPT was approved, so the drawer can show one row per turn AND
 * filter to the message the user has currently selected.
 */
export function useRunsForTarget(
  targetVfsPath: string | null | undefined,
  options?: { enabled?: boolean; sourceFlowMessageId?: string | null },
) {
  const key = targetVfsPath || '';
  const sourceFmId = options?.sourceFlowMessageId || '';
  const query = useMemo(() => {
    const eqClauses: Array<{ op: string; operands: unknown[] }> = [
      { op: '$EQ', operands: ['target_vfs_path', key] },
    ];
    if (sourceFmId) {
      eqClauses.push({ op: '$EQ', operands: ['source_flow_message_id', sourceFmId] });
    }
    return new QueryRequest({
      type: Run.type,
      scope: [],
      name: `runsForTarget:${key || 'none'}${sourceFmId ? `:${sourceFmId}` : ''}`,
      query: new QueryFilter({
        match: { op: '$AND', operands: eqClauses } as Record<string, unknown>,
      }),
    });
  }, [key, sourceFmId]);

  const enabled = (options?.enabled ?? true) && !!key;
  const { data, isLoading, error } = useEntitiesQuery<Run>(query, { enabled });

  return { runs: data ?? [], isLoading, error };
}
