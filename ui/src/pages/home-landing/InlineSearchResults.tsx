import { useRecordSearch, type SearchFilters, type SearchResult, getSearchResultBadgeLabel } from '@src/hooks/use-record-search';
import { cn } from '@src/lib/utils';
import { dataManager } from '@sdk';
import { getActionsForResult } from '@src/navigation/record-type-nav';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import type { ScopeFilter } from '@src/lib/scope-filter';
import { ArrowUpRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

const MAX_INLINE = 5;

const TYPE_COLORS: Record<string, string> = {
  bookmark: 'bg-violet-500/20 text-violet-700 dark:text-violet-300',
  session: 'bg-blue-500/20 text-blue-700 dark:text-blue-300',
  claude_session: 'bg-blue-500/20 text-blue-700 dark:text-blue-300',
  skill: 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-300',
  agent: 'bg-amber-500/20 text-amber-700 dark:text-amber-300',
  hook: 'bg-orange-500/20 text-orange-700 dark:text-orange-300',
  claude_hook: 'bg-orange-500/20 text-orange-700 dark:text-orange-300',
  command: 'bg-rose-500/20 text-rose-700 dark:text-rose-300',
  task: 'bg-teal-500/20 text-teal-700 dark:text-teal-300',
  agentic_process: 'bg-purple-500/20 text-purple-700 dark:text-purple-300',
  annotation: 'bg-sky-500/20 text-sky-700 dark:text-sky-300',
};

function timeAgo(iso?: string): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

interface InlineSearchResultsProps {
  query: string;
  filters: SearchFilters;
  scope: ScopeFilter;
  scopeLoading?: boolean;
  selectedIndex: number;
  onSelectedIndexChange: (i: number) => void;
  onOpenFullSearch: () => void;
  onNavigateResult: (result: SearchResult) => void;
}

export function InlineSearchResults({
  query,
  filters,
  scope,
  scopeLoading = false,
  selectedIndex,
  onSelectedIndexChange,
  onOpenFullSearch,
  onNavigateResult,
}: InlineSearchResultsProps) {
  const { t } = useLingui();
  const hasFilter = !!(filters.record_type || filters.status || filters.scope || filters.time_preset);
  const { navigation } = useDockNavigation();

  const [scanInfo, setScanInfo] = useState(() => dataManager.scanInfo);
  useEffect(() => dataManager.onScanInfoChange(setScanInfo), []);

  const [searchStartMs, setSearchStartMs] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);

  // Track when a search begins
  const prevQuery = useRef(query);
  const prevFilters = useRef(filters);
  const prevScopeLoading = useRef(scopeLoading);
  useEffect(() => {
    const filtersChanged =
      filters.record_type !== prevFilters.current.record_type ||
      filters.status !== prevFilters.current.status ||
      filters.scope !== prevFilters.current.scope ||
      filters.time_preset !== prevFilters.current.time_preset;
    const scopeReadyChanged = prevScopeLoading.current && !scopeLoading;
    if (query !== prevQuery.current || filtersChanged || scopeReadyChanged) {
      setSearchStartMs(Date.now());
      setElapsedMs(null);
    }
    prevQuery.current = query;
    prevFilters.current = filters;
    prevScopeLoading.current = scopeLoading;
  }, [query, filters, scopeLoading]);

  const requestQuery = scopeLoading ? '' : query;
  const requestFilters = scopeLoading ? {} : filters;
  const { results, isLoading: searchLoading } = useRecordSearch(requestQuery, requestFilters, {}, scope);
  const isLoading = scopeLoading || searchLoading;

  // Record elapsed time when results arrive
  useEffect(() => {
    if (!isLoading && searchStartMs !== null) {
      setElapsedMs(Date.now() - searchStartMs);
    }
  }, [isLoading, searchStartMs]);

  if (!hasFilter && query.length < 2) return null;

  const displayResults = results.slice(0, MAX_INLINE - (results.length > MAX_INLINE ? 1 : 0));
  const hasOverflow = results.length > MAX_INLINE;
  const totalSlots = hasOverflow ? MAX_INLINE : displayResults.length;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = selectedIndex + 1;
      onSelectedIndexChange(next > totalSlots - 1 ? -1 : next);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = selectedIndex - 1;
      onSelectedIndexChange(prev < 0 ? -1 : prev);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (selectedIndex === MAX_INLINE - 1 && hasOverflow) {
        onOpenFullSearch();
      } else if (selectedIndex >= 0 && selectedIndex < displayResults.length) {
        onNavigateResult(displayResults[selectedIndex]);
      }
    } else if (e.key === 'Escape') {
      onSelectedIndexChange(-1);
    }
  };

  return (
    <div
      className="flex flex-col rounded-lg border border-border bg-card overflow-hidden"
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="text-xs text-muted-foreground">
          {isLoading
            ? <Trans>Searching…</Trans>
            : elapsedMs !== null
              ? `${results.length} result${results.length !== 1 ? 's' : ''}${scanInfo?.total_indexed ? ` · ${scanInfo.total_indexed.toLocaleString()} indexed` : ''} · ${elapsedMs}ms`
              : <Trans>Ready</Trans>}
        </span>
        <button
          type="button"
          onClick={onOpenFullSearch}
          title={t`Open full search`}
          className="rounded p-0.5 text-muted-foreground hover:text-foreground"
        >
          <ArrowUpRight className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Loading skeletons */}
      {isLoading && (
        <div className="flex flex-col gap-1 p-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="animate-pulse h-8 rounded bg-muted" />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!isLoading && results.length === 0 && (
        <div className="px-3 py-3 text-sm text-muted-foreground"><Trans>No results</Trans></div>
      )}

      {/* Result rows — div+role=button (not <button>) so the per-action
          chips below can be real <button>s without nesting buttons. Selection
          + Enter activation are handled by the container's handleKeyDown. */}
      {!isLoading && displayResults.map((result, i) => (
        <div
          key={result.record_id}
          role="button"
          tabIndex={-1}
          className={cn(
            'flex w-full flex-col gap-0.5 px-3 py-2 text-left cursor-pointer',
            selectedIndex === i ? 'bg-accent text-foreground' : 'hover:bg-accent/50',
          )}
          onClick={() => onNavigateResult(result)}
          onMouseEnter={() => onSelectedIndexChange(i)}
        >
          {/* Top line: badge · title · time */}
          <div className="flex items-center gap-2 text-sm">
            <span
              className={cn(
                'shrink-0 rounded border px-1.5 py-0 text-[10px] font-medium',
                TYPE_COLORS[result.record_type] ?? 'bg-muted text-muted-foreground',
              )}
            >
              {getSearchResultBadgeLabel(result)}
            </span>
            <span className="flex-1 truncate font-semibold">{result.fts_title ?? result.name ?? result.record_id}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(result.modified_at)}</span>
          </div>
          {/* Snippet (with highlights) or description */}
          {result.snippet ? (
            <p
              className="line-clamp-2 text-xs text-muted-foreground pl-[calc(theme(spacing.1)+0.5rem)] [&_mark]:bg-yellow-200 [&_mark]:text-yellow-900 dark:[&_mark]:bg-yellow-800/60 dark:[&_mark]:text-yellow-200 [&_mark]:rounded-sm [&_mark]:px-0.5"
              dangerouslySetInnerHTML={{ __html: result.snippet.replace(/^(user:|assistant:)\s*/i, '') }}
            />
          ) : result.fts_description ? (
            <p className="truncate text-xs text-muted-foreground pl-[calc(theme(spacing.1)+0.5rem)]">
              {result.fts_description}
            </p>
          ) : null}
          {/* Action chips */}
          {(() => {
            const actions = getActionsForResult(result);
            if (actions.length === 0) return null;
            return (
              <div className="flex flex-wrap gap-1 pt-0.5" onClick={(e) => e.stopPropagation()}>
                {actions.map((a) => (
                  <button
                    key={a.name}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (a.action) {
                        void a.action(result, navigation);
                      } else if (a.dockPointer) {
                        navigation.openDock(a.dockPointer(result));
                      }
                    }}
                    className="flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                  >
                    <a.icon className="h-2.5 w-2.5" />
                    {a.name}
                  </button>
                ))}
              </div>
            );
          })()}
        </div>
      ))}

      {/* See all overflow row */}
      {!isLoading && hasOverflow && (
        <button
          type="button"
          className={cn(
            'flex w-full items-center gap-1 px-3 py-2 text-left text-sm font-medium text-primary',
            selectedIndex === MAX_INLINE - 1 ? 'bg-accent' : 'hover:bg-accent/50',
          )}
          onClick={onOpenFullSearch}
          onMouseEnter={() => onSelectedIndexChange(MAX_INLINE - 1)}
        >
          <ArrowUpRight className="h-3.5 w-3.5" />
          <Trans>See all {results.length} results →</Trans>
        </button>
      )}
    </div>
  );
}
