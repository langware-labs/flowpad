import { ActionInfo, dataManager } from '@sdk';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface TriggerLogEntry {
  id: string;
  ts: string;
  hook_event: string;
  trigger: boolean;
  reason: string;
  is_test: boolean;
  rule_name: string;
  actions: string[];
  agentic_process_id?: string | null;
  // Structured fields (nullable for back-compat with pre-Chunk-C entries).
  // `event_kind` is the typed discriminator the UI switches on; legacy
  // entries without it fall through to the hook-shape rendering.
  event_kind?: 'hook' | 'schedule_fire' | 'file_change' | 'test' | null;
  changed_path?: string | null;
  change_type?: string | null;
  // Batch fields — populated for file_change rows that coalesced N events
  // into one fire. When undefined or changes_total <= 1 the UI falls back to
  // single-event rendering against changed_path/change_type.
  changes?: { path: string; change_type: string }[] | null;
  changes_total?: number | null;
  changes_truncated?: number | null;
}

const POLL_INTERVAL_MS = 5000;

/**
 * Fetches and polls the invocation log for a trigger.
 * Uses GET /api/v1/graph/trigger/{id}/log?limit=20
 */
export function useTriggerLog(triggerId: string | null, limit = 20) {
  const [entries, setEntries] = useState<TriggerLogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchEntries = useCallback(async (id: string) => {
    const action = new ActionInfo('log', 'trigger', id, 'GET');
    action.queryParameters = { limit: String(limit) };
    const data = await dataManager.callAction<undefined, TriggerLogEntry[]>(action);
    if (Array.isArray(data)) {
      setEntries(data);
    }
  }, [limit]);

  useEffect(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setEntries([]);

    if (!triggerId) return;

    setIsLoading(true);
    fetchEntries(triggerId)
      .catch(() => {})
      .finally(() => setIsLoading(false));

    intervalRef.current = setInterval(() => {
      fetchEntries(triggerId).catch(() => {});
    }, POLL_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [triggerId, fetchEntries]);

  const refresh = () => {
    if (triggerId) fetchEntries(triggerId).catch(() => {});
  };

  return { entries, isLoading, refresh };
}
