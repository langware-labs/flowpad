import { ActionInfo, AgenticProcess, ConnectionManager, type DataOpType, type IEntity } from '@sdk';
import { useEffect, useMemo, useRef } from 'react';
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

  // Set of AgenticProcess ids already represented in the list, so the data_op
  // subscription can tell "a chat we don't show yet just appeared" from the
  // chatty status ticks of chats already on screen.
  const knownProcessIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    knownProcessIdsRef.current = new Set(
      entries.map((e) => e.agentic_process_id).filter((id): id is string => !!id),
    );
  }, [entries]);

  // Keep the (derived, non-live) worker-history list current as AgenticProcess
  // entities change. `worker-history` is a `useAction` query — it doesn't auto-
  // refetch on data_ops — so a freshly-started chat would otherwise not appear
  // until reload. `refetch()` preserves the prior `data` while in flight (it only
  // setData on success), so the list never blanks → no flicker; the new row just
  // reconciles in.
  //   • create/delete → always refetch (a chat was added/removed).
  //   • update → refetch ONLY if the process isn't already shown. A brand-new AP
  //     surfaces once it has a session_id/transcript (an update, not the create),
  //     so we must catch that transition; but updates to a chat already in the
  //     list (title/status ticks) must NOT trigger a transcript re-walk.
  useEffect(() => {
    if (!enabled || !computeNode?.typeId?.id) return;
    const cm = ConnectionManager.getInstance();
    const handler = (_typeIdStr: string, op: DataOpType, entity: IEntity) => {
      if (entity?.type !== AgenticProcess.type) return;
      if (op === 'create' || op === 'delete') {
        void refetch();
        return;
      }
      if (entity.id && !knownProcessIdsRef.current.has(entity.id)) void refetch();
    };
    cm.on('on_data_op', handler);
    return () => {
      cm.off('on_data_op', handler);
    };
  }, [enabled, computeNode?.typeId?.id, refetch]);

  return { entries, isLoading, refetch };
}
