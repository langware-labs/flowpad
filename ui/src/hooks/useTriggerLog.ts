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
  // Bus alignment (docs/flow-events.md). `event_id` is the `trigger.*` envelope
  // THIS ROW IS — the join key between the durable log and the live feed. The
  // `cause_*` trio describes the envelope that caused the fire (tag rules only).
  // All optional: rows written before the emitters existed carry none of them.
  event_id?: string | null;
  cause_event_id?: string | null;
  cause_tag?: string | null;
  cause_target?: string | null;
  actor?: string | null;
  trigger_id?: string | null;
  trigger_type?: string | null;
  /** Why a fire did NOT happen: storm | confirm_failed | disabled | self_loop. */
  reason_code?: string | null;
}

const POLL_INTERVAL_MS = 5000;

interface Options {
  /** Cap on rows returned. */
  limit?: number;
  /** Only rows where the rule actually fired. */
  triggeredOnly?: boolean;
  /** Stop polling (e.g. the feed is paused) without unmounting. */
  enabled?: boolean;
}

/**
 * Trigger outcomes, polled.
 *
 * ONE hook for both questions, because they differ only in which action is
 * called: pass a rule id for "what did THIS rule do" (`log`), or `null` for
 * "what has been happening" across every rule (`fires`). They were briefly two
 * near-identical hooks; the poll loop, the abort semantics and the interval only
 * need fixing in one place.
 *
 * REST rather than the bus because `trigger.*` is deliberately not forwarded to
 * the app, and because the bus keeps no history — a backend restart would
 * otherwise empty the screen. See the pin test in
 * `tests/unit/test_trigger_tags.py` for the reason and the condition that
 * would change it.
 */
export function useTriggerLog(triggerId: string | null, options: Options = {}) {
  const { limit = 20, triggeredOnly = false, enabled = true } = options;
  const [entries, setEntries] = useState<TriggerLogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchEntries = useCallback(async () => {
    const action = triggerId
      ? new ActionInfo('log', 'trigger', triggerId, 'GET')
      : new ActionInfo('fires', 'trigger', null, 'GET');
    action.queryParameters = {
      limit: String(limit),
      ...(triggeredOnly ? { triggered_only: 'true' } : {}),
    };
    const data = await dataManager.callAction<undefined, TriggerLogEntry[]>(action);
    if (Array.isArray(data)) setEntries(data);
  }, [triggerId, limit, triggeredOnly]);

  useEffect(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (!enabled) return;

    setIsLoading(true);
    fetchEntries()
      .catch(() => {})
      .finally(() => setIsLoading(false));

    intervalRef.current = setInterval(() => {
      fetchEntries().catch(() => {});
    }, POLL_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [enabled, fetchEntries]);

  const refresh = useCallback(() => {
    fetchEntries().catch(() => {});
  }, [fetchEntries]);

  return { entries, isLoading, refresh };
}
