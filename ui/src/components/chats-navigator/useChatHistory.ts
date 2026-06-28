import { useMemo } from 'react';
import { AgenticProcess } from '@sdk';
import { useWorkerHistory, type WorkerHistoryEntry } from '@src/hooks/useWorkerHistory';
import { pickHistoryTitle } from '@src/components/entity-execution-panel/history-row';
import { isAllScope, scopeIncludesUser, scopeProjectIds, type ScopeFilter } from '@src/lib/scope-filter';

/**
 * Filters + grouping for the Chats history side-menu. Built on the existing
 * worker-history list (`useWorkerHistory`) — the same data the terminal's
 * HistoryModal and the chat dropdown show. Returns the entries scoped, searched
 * and grouped into the claude.ai-style time buckets.
 */
export interface ChatHistoryFilters {
  /** Project scope (URL-driven, same model as Assets/Triggers). */
  scope: ScopeFilter;
  /** Free-text search over title / last prompt / project. */
  search: string;
}

export interface ChatBucket {
  label: string;
  entries: WorkerHistoryEntry[];
}

function processFor(entry: WorkerHistoryEntry): AgenticProcess | null {
  return entry.agentic_process_id
    ? AgenticProcess.getByIdFromCache<AgenticProcess>(entry.agentic_process_id) ?? null
    : null;
}

export function isFavorite(entry: WorkerHistoryEntry): boolean {
  return processFor(entry)?.favorite_index != null;
}

/** A worker-history entry passes the project scope. `all` shows everything;
 *  `user` shows only unscoped entries; `project`/`filter` match by project_id
 *  (plus unscoped when the scope includes user). */
function matchesScope(entry: WorkerHistoryEntry, scope: ScopeFilter): boolean {
  if (isAllScope(scope)) return true;
  if (entry.project_id) return scopeProjectIds(scope).includes(entry.project_id);
  return scopeIncludesUser(scope);
}

function tsOf(entry: WorkerHistoryEntry): number {
  const t = entry.last_active_time ? new Date(entry.last_active_time).getTime() : NaN;
  return Number.isNaN(t) ? 0 : t;
}

/** Group a recency-sorted list into Today / Yesterday / Previous 7|30 days / Older. */
function bucketize(sorted: WorkerHistoryEntry[]): ChatBucket[] {
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 24 * 60 * 60 * 1000;
  const startYesterday = startToday - day;
  const start7 = startToday - 7 * day;
  const start30 = startToday - 30 * day;

  const buckets: ChatBucket[] = [
    { label: 'Today', entries: [] },
    { label: 'Yesterday', entries: [] },
    { label: 'Previous 7 days', entries: [] },
    { label: 'Previous 30 days', entries: [] },
    { label: 'Older', entries: [] },
  ];
  for (const entry of sorted) {
    const t = tsOf(entry);
    if (t >= startToday) buckets[0].entries.push(entry);
    else if (t >= startYesterday) buckets[1].entries.push(entry);
    else if (t >= start7) buckets[2].entries.push(entry);
    else if (t >= start30) buckets[3].entries.push(entry);
    else buckets[4].entries.push(entry);
  }
  return buckets.filter((b) => b.entries.length > 0);
}

export function useChatHistory(filters: ChatHistoryFilters, limit = 50) {
  const { entries, isLoading, refetch } = useWorkerHistory(limit);

  const buckets = useMemo<ChatBucket[]>(() => {
    const q = filters.search.trim().toLowerCase();
    const filtered = entries.filter((e) => {
      if (!matchesScope(e, filters.scope)) return false;
      if (q) {
        const title = pickHistoryTitle(processFor(e), e);
        const hay = `${title} ${e.last_prompt ?? ''} ${e.project_name ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const sorted = [...filtered].sort((a, b) => tsOf(b) - tsOf(a));
    return bucketize(sorted);
  }, [entries, filters]);

  const total = useMemo(() => buckets.reduce((n, b) => n + b.entries.length, 0), [buckets]);

  return { buckets, total, isLoading, refetch };
}
