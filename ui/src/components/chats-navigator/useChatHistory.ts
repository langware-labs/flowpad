import { t } from '@lingui/core/macro';
import { useEffect, useMemo, useRef } from 'react';
import { AgenticProcess, QueryFilter, QueryRequest } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { useWorkerHistory, type WorkerHistoryEntry } from '@src/hooks/useWorkerHistory';
import { toMs } from '@src/utils/process-recency';
import { pickHistoryTitle } from '@src/components/entity-execution-panel/history-row';
import { isAllScope, scopeIncludesUser, scopeProjectIds, type ScopeFilter } from '@src/lib/scope-filter';

/**
 * Filters + grouping for the Chats history side-menu. Built on the existing
 * worker-history list (`useWorkerHistory`) — the same data the terminal's
 * HistoryModal and the chat dropdown show. Returns the entries scoped, searched
 * and grouped into the claude.ai-style time buckets.
 *
 * Recency = "last active OR last opened": each entry's sort key is
 * max(transcript `last_active_time`, entity `last_active_at`) — the latter is
 * the server-side `activate` stamp every open fires. The worker-history action
 * is still fetched once (a running agent's op stream must not become a refetch
 * storm); OPEN recency instead arrives live through a watched entity query over
 * the listed sessions' AgenticProcess rows, which also supplies the
 * `agentic_process_id` minted by a first-time open (the heal), so the active
 * row can highlight without a refetch.
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
    ? (AgenticProcess.getByIdFromCache<AgenticProcess>(entry.agentic_process_id) ?? null)
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

/**
 * Anti-flicker stability window for the recency sort: two entries whose
 * recency timestamps differ by LESS than this must keep their current relative
 * order (a running session's stream of sub-minute updates must not shuffle the
 * list under the user's cursor). Production: 1 minute. Tests pass a small
 * window (e.g. 1s) via the `sortStabilityMs` parameter of `useChatHistory`.
 */
export const CHAT_SORT_STABILITY_MS = 60_000;

/** "Last active OR last opened": transcript content time vs the entity
 *  `activate` stamp. The third source is NOT a dup of the second: the row
 *  field is the backend/live-query snapshot, while `processFor` reads the
 *  cache the WS merge keeps fresh for entries whose id was already known. */
function tsOf(entry: WorkerHistoryEntry): number {
  return Math.max(toMs(entry.last_active_time), toMs(entry.last_active_at), toMs(processFor(entry)?.last_active_at));
}

/** Group a recency-sorted list into Today / Yesterday / Previous 7|30 days / Older. */
function bucketize(sorted: WorkerHistoryEntry[], ts: (e: WorkerHistoryEntry) => number): ChatBucket[] {
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 24 * 60 * 60 * 1000;
  const startYesterday = startToday - day;
  const start7 = startToday - 7 * day;
  const start30 = startToday - 30 * day;

  const buckets: ChatBucket[] = [
    { label: t`Today`, entries: [] },
    { label: t`Yesterday`, entries: [] },
    { label: t`Previous 7 days`, entries: [] },
    { label: t`Previous 30 days`, entries: [] },
    { label: t`Older`, entries: [] },
  ];
  for (const entry of sorted) {
    const t = ts(entry);
    if (t >= startToday) buckets[0].entries.push(entry);
    else if (t >= startYesterday) buckets[1].entries.push(entry);
    else if (t >= start7) buckets[2].entries.push(entry);
    else if (t >= start30) buckets[3].entries.push(entry);
    else buckets[4].entries.push(entry);
  }
  return buckets.filter((b) => b.entries.length > 0);
}

export function useChatHistory(
  filters: ChatHistoryFilters,
  limit = 50,
  /** Recency deltas smaller than this window must not reorder rows (see
   *  {@link CHAT_SORT_STABILITY_MS}); tests shrink it to keep runs fast. */
  sortStabilityMs: number = CHAT_SORT_STABILITY_MS,
) {
  // When scoped to one-or-more projects, push the project_ids to the backend so
  // the per-project cap is computed there — otherwise an under-active project's
  // sessions never make it into the response to be filtered client-side.
  const projectIds = isAllScope(filters.scope) ? undefined : scopeProjectIds(filters.scope);
  const { entries, isLoading, refetch } = useWorkerHistory(limit, {
    projectIds: projectIds?.length ? projectIds : undefined,
  });

  // Live AgenticProcess rows for the LISTED sessions only (`session_id $IN`):
  // an open of a never-materialized session mints its entity (the heal) and
  // every open re-stamps `last_active_at` — the watched query streams both in
  // without refetching worker-history (no op-storm; membership is bounded by
  // the visible list).
  const sessionIdsKey = useMemo(
    () =>
      entries
        .map((e) => e.worker_id)
        .filter(Boolean)
        .sort()
        .join(','),
    [entries],
  );
  const processQuery = useMemo(
    () =>
      new QueryRequest({
        type: AgenticProcess.type,
        scope: [],
        name: `chatHistoryProcesses:${sessionIdsKey.split(',').length}sessions`,
        // $OR of $EQ (not $IN): the client-side data_op re-validator only
        // evaluates $IN in its array-field ($PROP) form, so a scalar-field $IN
        // would silently drop live membership updates — the whole point here.
        query: new QueryFilter({
          match: {
            op: '$OR',
            operands: sessionIdsKey.split(',').map((sid) => ({ op: '$EQ', operands: ['session_id', sid] })),
          },
        }),
      }),
    [sessionIdsKey],
  );
  const { data: liveProcesses } = useEntitiesQuery<AgenticProcess>(processQuery, {
    enabled: sessionIdsKey.length > 0,
  });

  // In-place UPDATE ops on member rows (the `activate` stamp) re-notify the
  // watched query (store.ts onDataOp update reconcile), so `liveProcesses` is
  // the single live signal — no per-entity subscription bridge needed.

  // Anti-flicker memory: worker_id → rank of the PREVIOUSLY RENDERED order.
  // Committed in an effect (not inside the memo) so the memo stays pure under
  // StrictMode/concurrent double-invocation.
  const prevRankRef = useRef<Map<string, number>>(new Map());

  const { buckets, order } = useMemo(() => {
    const bySession = new Map<string, AgenticProcess>();
    for (const p of liveProcesses ?? []) {
      if (p.session_id) bySession.set(p.session_id, p);
    }

    const q = filters.search.trim().toLowerCase();
    const filtered = entries
      .map((e) => {
        // Reconcile the row with its live entity: a first-time open minted the
        // AgenticProcess AFTER this list was fetched — adopt its id (the
        // highlight key) and its open stamp.
        const live = bySession.get(e.worker_id);
        if (!live) return e;
        return {
          ...e,
          agentic_process_id: e.agentic_process_id ?? live.id,
          last_active_at: Math.max(toMs(e.last_active_at), toMs(live.last_active_at)) || null,
        };
      })
      .filter((e) => {
        if (!matchesScope(e, filters.scope)) return false;
        if (q) {
          const title = pickHistoryTitle(processFor(e), e);
          const hay = `${title} ${e.last_prompt ?? ''} ${e.project_name ?? ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });

    // Each entry's recency is invariant within one recompute — resolve it once
    // (tsOf does a cache lookup) instead of per comparator call.
    const recency = new Map(filtered.map((e) => [e.worker_id, tsOf(e)]));
    const ts = (e: WorkerHistoryEntry) => recency.get(e.worker_id) ?? 0;

    // Recency sort with the stability window: an over-window delta orders by
    // time; an under-window delta keeps the previously rendered relative order
    // (both ranks known), so live sessions don't shuffle under the cursor.
    const prevRank = prevRankRef.current;
    const sorted = [...filtered].sort((a, b) => {
      const delta = ts(b) - ts(a);
      if (Math.abs(delta) >= sortStabilityMs) return delta;
      const ra = prevRank.get(a.worker_id);
      const rb = prevRank.get(b.worker_id);
      if (ra != null && rb != null && ra !== rb) return ra - rb;
      return delta;
    });
    return { buckets: bucketize(sorted, ts), order: sorted.map((e) => e.worker_id) };
  }, [entries, filters, liveProcesses, sortStabilityMs]);

  useEffect(() => {
    prevRankRef.current = new Map(order.map((id, i) => [id, i]));
  }, [order]);

  const total = useMemo(() => buckets.reduce((n, b) => n + b.entries.length, 0), [buckets]);

  return { buckets, total, isLoading, refetch };
}
