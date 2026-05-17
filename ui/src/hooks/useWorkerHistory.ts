import { ActionInfo } from '@sdk';
import { useMemo } from 'react';
import { useAction } from './use-action';
import { useContext } from './useContext';

export type WorkerType = 'claude' | 'codex';

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

export function useWorkerHistory(limit = 10, options?: { enabled?: boolean }) {
  const enabled = options?.enabled ?? true;
  const { computeNode } = useContext();

  const actionInfo = useMemo(() => {
    if (!computeNode?.typeId?.id) return null;
    const info = new ActionInfo('worker-history', 'compute_node', computeNode.typeId.id, 'GET');
    info.queryParameters = { limit: String(limit) };
    return info;
  }, [computeNode?.typeId?.id, limit]);

  const { data, isLoading, refetch } = useAction<WorkerHistoryEntry[]>(actionInfo, {
    enabled: enabled && !!computeNode?.typeId?.id,
  });

  const entries = useMemo<WorkerHistoryEntry[]>(() => {
    if (!data || !Array.isArray(data)) return [];
    return data;
  }, [data]);

  return { entries, isLoading, refetch };
}
