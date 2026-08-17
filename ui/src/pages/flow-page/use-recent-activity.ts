import { useMemo, useSyncExternalStore } from 'react';
import { dataManager, Project, type RecentEntityEdit } from '@sdk';
import { useChatHistory } from '@src/components/chats-navigator/useChatHistory';
import type { WorkerHistoryEntry } from '@src/hooks/useWorkerHistory';
import { useRecordSearch, type SearchResult } from '@src/hooks/use-record-search';
import { isResultNavigable, resultTypeId } from '@src/navigation/record-type-nav';
import { pinnedProjectId, projectIdInScope, type ScopeFilter } from '@src/lib/scope-filter';
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

interface RecentEditEntity {
  displayName: string;
  system?: boolean;
  project_id?: string | null;
  scope?: string | null;
}

/** Project one client-local edit intent into the same lightweight row shape as
 * the durable recent-activity query. The intent is display-only: the backend
 * remains the owner of ``last_edited_at`` and receives its coalesced stamp on
 * the established trailing schedule. */
export function recentEditSearchResult(
  edit: RecentEntityEdit,
  entity: RecentEditEntity | null,
  scope: ScopeFilter,
): SearchResult | null {
  if (!entity || entity.system) return null;
  const projectId = edit.target.type === Project.type
    ? edit.target.id
    : (entity.project_id ?? null);
  if (!projectIdInScope(projectId, scope, pinnedProjectId(scope))) return null;

  return {
    record_id: edit.target.id,
    record_type: edit.target.type,
    name: entity.displayName,
    text: '',
    status: 'indexed',
    scope: entity.scope ?? (projectId ? 'project' : 'user'),
    created_at: '',
    modified_at: '',
    last_edited_at: edit.markedAt,
    asset_ref: '',
  };
}

const subscribeToRecentEdits = (callback: () => void) => (
  dataManager.onRecentEntityEditsChange(callback)
);
const getRecentEditsSnapshot = () => dataManager.getRecentEntityEdits();

function useLocalRecentEditResults(scope: ScopeFilter): SearchResult[] {
  const edits = useSyncExternalStore(
    subscribeToRecentEdits,
    getRecentEditsSnapshot,
    getRecentEditsSnapshot,
  );

  return useMemo(
    () => edits.flatMap((edit) => {
      const entity: RecentEditEntity | null = dataManager.getByTypeIdFromCache(edit.target);
      const result = recentEditSearchResult(edit, entity, scope);
      return result ? [result] : [];
    }),
    [edits, scope],
  );
}

function mergeEditedEntityRows(
  durable: readonly SearchResult[],
  local: readonly SearchResult[],
): SearchResult[] {
  const rows = new Map<string, SearchResult>();
  for (const result of durable) {
    rows.set(`${result.record_type}:${resultEntityId(result)}`, result);
  }
  for (const result of local) {
    const key = `${result.record_type}:${resultEntityId(result)}`;
    const existing = rows.get(key);
    rows.set(key, existing
      ? {
          ...existing,
          name: result.name || existing.name,
          last_edited_at: Math.max(toMs(existing.last_edited_at), toMs(result.last_edited_at)),
        }
      : result);
  }
  return [...rows.values()];
}

/** Combine the two existing recency sources into one deterministic timeline.
 * A materialized AgenticProcess is the same user activity as its worker-history
 * session, so it contributes its edit stamp to that session instead of
 * rendering a duplicate row. Rows without a working navigation target never
 * enter the feed. */
export function mergeRecentActivity(
  editedEntities: readonly SearchResult[],
  sessions: readonly WorkerHistoryEntry[],
  localEdits: readonly SearchResult[] = [],
): RecentActivityItem[] {
  const mergedEntities = mergeEditedEntityRows(editedEntities, localEdits);
  const processEdits = new Map<string, number>();
  for (const result of mergedEntities) {
    if (result.record_type === 'agentic_process') {
      processEdits.set(resultEntityId(result), toMs(result.last_edited_at));
    }
  }

  const representedProcessIds = new Set(
    sessions
      .map((entry) => entry.agentic_process_id)
      .filter((id): id is string => !!id),
  );

  const entityItems: RecentActivityItem[] = mergedEntities.flatMap((result) => {
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
  const localEdits = useLocalRecentEditResults(scope);
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
    () => mergeRecentActivity(editedEntities, sessions, localEdits),
    [editedEntities, localEdits, sessions],
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
