import { ActionInfo } from '@sdk';
import { useMemo } from 'react';
import { useAction } from './use-action';
import { useContext } from './useContext';

/** Worker vendors as the worker-history action reports them (NOT the launch
 *  `claude_code` form). Single source for the union + any vendor chip list. */
export const WORKER_TYPES = ['claude', 'codex', 'copilot'] as const;
export type WorkerType = (typeof WORKER_TYPES)[number];

export interface WorkerHistoryEntry {
  worker_type: WorkerType;
  worker_id: string;
  project_id: string | null;
  project_name: string | null;
  project_cwd: string | null;
  last_active_time: string;
  name: string | null;
  last_prompt: string | null;
  git_branch: string | null;
  message_count: number | null;
  agentic_process_id: string | null;
}

export function useWorkerHistory(
  limit = 10,
  options?: { enabled?: boolean; projectIds?: string[] },
) {
  const enabled = options?.enabled ?? true;
  const { computeNode } = useContext();

  // Stable key so the memo doesn't refire on a fresh-but-equal array each render.
  const projectIdsKey = options?.projectIds?.length ? [...options.projectIds].sort().join(',') : '';

  const actionInfo = useMemo(() => {
    if (!computeNode?.typeId?.id) return null;
    const info = new ActionInfo('worker-history', 'compute_node', computeNode.typeId.id, 'GET');
    // When a project scope is active, pass it so the backend caps per-project
    // (an under-active project isn't squeezed out of a global top-N).
    info.queryParameters = projectIdsKey
      ? { limit: String(limit), project_ids: projectIdsKey }
      : { limit: String(limit) };
    return info;
  }, [computeNode?.typeId?.id, limit, projectIdsKey]);

  const { data, isLoading, refetch } = useAction<WorkerHistoryEntry[]>(actionInfo, {
    enabled: enabled && !!computeNode?.typeId?.id,
  });

  const entries = useMemo<WorkerHistoryEntry[]>(() => {
    if (!data || !Array.isArray(data)) return [];
    return data;
  }, [data]);

  // `worker-history` is fetched ONCE on load (a plain `useAction` query keyed by
  // compute node + limit + project scope). It intentionally does NOT auto-refetch
  // on AgenticProcess data_ops — a running agent emits a stream of status/
  // transcript update ops, and refetching per op turned into a request storm.
  // Callers that need a fresh list drive it explicitly via the returned `refetch`.
  return { entries, isLoading, refetch };
}
