import { useMemo } from 'react';
import { useChatHistory } from '@src/components/chats-navigator/useChatHistory';
import type { WorkerHistoryEntry } from '@src/hooks/useWorkerHistory';
import { useRecordSearch, type SearchResult } from '@src/hooks/use-record-search';
import { isResultNavigable, resultTypeId } from '@src/navigation/record-type-nav';
import type { ScopeFilter } from '@src/lib/scope-filter';
import { toMs } from '@src/utils/process-recency';

export type RecentActivityItem =
  | {
      kind: 'entity';
      key: string;
      timestampMs: number;
      result: SearchResult;
    }
  | {
      kind: 'session';
      key: string;
      timestampMs: number;
      entry: WorkerHistoryEntry;
    };

function resultEntityId(result: SearchResult): string {
  return resultTypeId(result)?.id ?? result.record_id;
}

/** Combine the two existing recency sources into one deterministic timeline.
 * A materialized AgenticProcess is the same user activity as its worker-history
 * session, so it contributes its edit stamp to that session instead of
 * rendering a duplicate row. Rows without a working navigation target never
 * enter the feed. */
export function mergeRecentActivity(
  editedEntities: readonly SearchResult[],
  sessions: readonly WorkerHistoryEntry[],
): RecentActivityItem[] {
  const processEdits = new Map<string, number>();
  for (const result of editedEntities) {
    if (result.record_type === 'agentic_process') {
      processEdits.set(resultEntityId(result), toMs(result.last_edited_at));
    }
  }

  const representedProcessIds = new Set(
    sessions
      .map((entry) => entry.agentic_process_id)
      .filter((id): id is string => !!id),
  );

  const entityItems: RecentActivityItem[] = editedEntities.flatMap((result) => {
    const timestampMs = toMs(result.last_edited_at);
    if (!timestampMs || !isResultNavigable(result)) return [];
    if (
      result.record_type === 'agentic_process'
      && representedProcessIds.has(resultEntityId(result))
    ) {
      return [];
    }
    return [{
      kind: 'entity' as const,
      key: `entity:${result.record_type}:${resultEntityId(result)}`,
      timestampMs,
      result,
    }];
  });

  const sessionItems: RecentActivityItem[] = sessions.flatMap((entry) => {
    if (!entry.worker_id) return [];
    const timestampMs = Math.max(
      toMs(entry.last_active_time),
      toMs(entry.last_active_at),
      entry.agentic_process_id ? (processEdits.get(entry.agentic_process_id) ?? 0) : 0,
    );
    if (!timestampMs) return [];
    return [{
      kind: 'session' as const,
      key: `session:${entry.worker_type}:${entry.worker_id}`,
      timestampMs,
      entry,
    }];
  });

  return [...entityItems, ...sessionItems].sort(
    (a, b) => b.timestampMs - a.timestampMs || a.key.localeCompare(b.key),
  );
}

export function useRecentActivity(scope: ScopeFilter, limit: number) {
  const {
    results: editedEntities,
    total: editedEntityTotal,
    isLoading: entitiesLoading,
    error,
  } = useRecordSearch(
    '',
    { sort_by: 'last_edited_at' },
    {},
    scope,
    300,
    { limit },
  );
  const { buckets, isLoading: sessionsLoading } = useChatHistory(
    { scope, search: '' },
    limit,
  );
  const sessions = useMemo(() => buckets.flatMap((bucket) => bucket.entries), [buckets]);
  const items = useMemo(
    () => mergeRecentActivity(editedEntities, sessions),
    [editedEntities, sessions],
  );

  return {
    items,
    isLoading: entitiesLoading || sessionsLoading,
    error,
    // Worker history is an array-only endpoint, so equality is the only
    // available "there may be another page" signal. One harmless extra load
    // resolves the exact-boundary case.
    hasMore: editedEntities.length < editedEntityTotal || sessions.length >= limit,
  };
}
