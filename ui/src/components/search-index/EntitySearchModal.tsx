import { useEffect, useState } from 'react';
import apiClient from '@sdk/client';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { AssetDataTable } from '@src/components/assets/AssetDataTable';
import { applyScopeToParams, type ScopeFilter } from '@src/lib/scope-filter';
import type { SearchResult } from '@src/hooks/use-record-search';
import { navigateToResult } from '@src/navigation/record-type-nav';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

const SEARCH_PATH = '/graph/compute_node/@local/fs-records/search';

/**
 * Generic entity-search-results table in a modal. Backed by the generic
 * `/fs-records/search` endpoint — pass any query (record type, scope, free
 * text) and it renders the standard `AssetDataTable` of results, each row
 * navigable to its entity. Reusable for any "show me these entities" need;
 * the scanner uses it to open "recently indexed" per type.
 */
export interface EntitySearchModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Narrow to a single record type (empty/undefined = browse handled by caller's q). */
  recordType?: string;
  /** Scope filter (user / projects) applied to the query. */
  scope?: ScopeFilter;
  /** Optional free-text FTS query. Omit for a filter-only browse. */
  q?: string;
  /** Max rows to fetch. */
  limit?: number;
}

export function EntitySearchModal({
  open,
  onOpenChange,
  title,
  recordType,
  scope,
  q,
  limit = 200,
}: EntitySearchModalProps) {
  const { navigation } = useDockNavigation();
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (recordType) params.set('record_type', recordType);
    params.set('limit', String(limit));
    if (scope) applyScopeToParams(params, scope);
    apiClient
      .get(`${SEARCH_PATH}?${params.toString()}`)
      .then((data: unknown) => {
        if (cancelled) return;
        const rows = ((data as { results?: SearchResult[] } | null)?.results ?? [])
          // Most-recently indexed first (recency by updated_date / modified_at).
          .slice()
          .sort((a, b) => (b.modified_at || '').localeCompare(a.modified_at || ''));
        setResults(rows);
      })
      .catch(() => { if (!cancelled) { setResults([]); setError(true); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, recordType, q, limit, scope]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="text-sm font-semibold">
            {title}
            {!loading && <span className="ml-2 text-xs font-normal text-muted-foreground">{results.length}</span>}
          </DialogTitle>
        </DialogHeader>
        {loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
        ) : error ? (
          <div className="py-8 text-center text-sm text-destructive">Failed to load entities.</div>
        ) : results.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">No entities.</div>
        ) : (
          <div className="max-h-[60vh] overflow-auto">
            <AssetDataTable
              results={results}
              total={results.length}
              page={1}
              pageSize={results.length}
              onPageChange={() => {}}
              recordType={recordType ?? ''}
              onRowClick={(r) => { void navigateToResult(r, navigation); onOpenChange(false); }}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
