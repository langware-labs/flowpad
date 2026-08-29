import { ActionInfo, AgenticProcess } from '@sdk';
import { useMemo } from 'react';
import { useAction } from './use-action';
import { useContext } from './useContext';

/** Worker vendors as the worker-history action reports them (NOT the launch
 *  `claude_code` form). Single source for the union + any vendor chip list. */
export const WORKER_TYPES = ['claude', 'codex', 'copilot', 'opencode'] as const;
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
  /** Epoch-ms open-recency stamp of the backing AgenticProcess (the `activate`
   *  action fired on every open). `last_active_time` is transcript recency
   *  only; "last active OR last opened" consumers take the max of the two. */
  last_active_at?: number | null;
}

/**
 * A row with no evidence of a turn: no count, no prompt, no title. `name` is
 * what keeps it honest — the backend coerces a real 0 to null, so a count alone
 * cannot tell "empty" from "unknown". FLOWPAD-2030: hidden, never deleted.
 */
export function isEmptyChatEntry(
  entry: Pick<WorkerHistoryEntry, 'message_count' | 'last_prompt' | 'name'>,
): boolean {
  return !entry.message_count && !entry.last_prompt?.trim() && !entry.name?.trim();
}

export function useWorkerHistory(
  limit = 10,
  options?: {
    enabled?: boolean;
    projectIds?: string[];
    /** Overrides the auto-detected current chat, which the filter exempts. */
    currentProcessId?: string | null;
    /** Opt OUT of the empty-chat filter; for metadata joins, not rendered lists. */
    includeEmpty?: boolean;
  },
) {
  const enabled = options?.enabled ?? true;
  const includeEmpty = options?.includeEmpty ?? false;
  const { computeNode, activeTerminalTargetTypeId } = useContext();

  // The chat the user is in is exempt from the filter, and it is resolved HERE
  // so every surface inherits the exemption — not just the ones that remember to
  // pass it. Clicking "New" lands you in a chat that is empty by definition.
  const currentProcessId =
    options?.currentProcessId
    ?? (activeTerminalTargetTypeId?.type === AgenticProcess.type ? activeTerminalTargetTypeId.id : null);

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

  // Filtered here, the one place history is loaded, so every surface inherits it.
  const entries = useMemo<WorkerHistoryEntry[]>(() => {
    if (!data || !Array.isArray(data)) return [];
    if (includeEmpty) return data;
    return data.filter(
      (e) => !isEmptyChatEntry(e) || (!!currentProcessId && e.agentic_process_id === currentProcessId),
    );
  }, [data, includeEmpty, currentProcessId]);

  // Pre-filter length: a hidden row still consumed page budget, so paging must
  // compare THIS against the page limit, never `entries.length`.
  const fetchedCount = Array.isArray(data) ? data.length : 0;

  // `worker-history` is fetched ONCE on load (a plain `useAction` query keyed by
  // compute node + limit + project scope). It intentionally does NOT auto-refetch
  // on AgenticProcess data_ops — a running agent emits a stream of status/
  // transcript update ops, and refetching per op turned into a request storm.
  // Callers that need a fresh list drive it explicitly via the returned `refetch`.
  return { entries, fetchedCount, isLoading, refetch };
}
