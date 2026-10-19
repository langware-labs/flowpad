import { useRecordSearch, type SearchFilters, type SearchResult } from '@src/hooks/use-record-search';
import { cn } from '@src/lib/utils';
import { dataManager } from '@sdk';
import { SearchResultCard } from '@src/components/record-search-bar/SearchResultCard';
import type { ScopeFilter } from '@src/lib/scope-filter';
import { ArrowUpRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

const MAX_INLINE = 5;

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
      className="flex flex-col overflow-hidden rounded-lg border border-border bg-card"
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="text-xs text-muted-foreground">
          {isLoading ? (
            <Trans>Searching…</Trans>
          ) : elapsedMs !== null ? (
            `${results.length} result${results.length !== 1 ? 's' : ''}${scanInfo?.total_indexed ? ` · ${scanInfo.total_indexed.toLocaleString()} indexed` : ''} · ${elapsedMs}ms`
          ) : (
            <Trans>Ready</Trans>
          )}
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
            <div key={i} className="h-8 animate-pulse rounded bg-muted" />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!isLoading && results.length === 0 && (
        <div className="px-3 py-3 text-sm text-muted-foreground">
          <Trans>No results</Trans>
        </div>
      )}

      {/* Result rows — div+role=button (not <button>) so the per-action
          chips below can be real <button>s without nesting buttons. Selection
          + Enter activation are handled by the container's handleKeyDown. */}
      {!isLoading &&
        displayResults.map((result, i) => (
          <SearchResultCard
            key={result.record_id}
            result={result}
            variant="inline"
            selected={selectedIndex === i}
            onClick={() => onNavigateResult(result)}
            onMouseEnter={() => onSelectedIndexChange(i)}
          />
        ))}

      {/* See all overflow row */}
      {!isLoading && hasOverflow && (
        <button
          type="button"
          className={cn(
            'flex w-full items-center gap-1 px-3 py-2 text-start text-sm font-medium text-primary',
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
