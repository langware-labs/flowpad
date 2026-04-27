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
