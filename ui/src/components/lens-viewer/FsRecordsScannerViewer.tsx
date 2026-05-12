import apiClient from '@sdk/client';
import { RecordSearchBar } from '@src/components/record-search-bar/RecordSearchBar';
import { SearchResultCard } from '@src/components/record-search-bar/SearchResultCard';
import { ActivityProgressBar, ActivityProgressModal } from '@src/components/search-index/ActivityProgressModal';
import { useIndexStatus } from '@src/hooks/use-index-status';
import { useSystemTools } from '@src/hooks/use-system-tools';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, ChevronDown, ChevronRight, Search, Database, FileSearch, Trash2, ScanSearch } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@src/components/ui/alert-dialog';
import { SearchFilters, useRecordSearch } from '@src/hooks/use-record-search';
import { formatTimeAgo } from '@src/utils/format-time-ago';

const BASE = '/graph/compute_node/@local/fs-records';
const SCAN_PATH = `${BASE}/scan`;

// Lens of the canonical indexer: every per-type row is sourced from
// `/fs-records/index-status`, every action drives `POST /fs-records/index`
// (aggregate), and every progress frame comes from the same WS feed the
// footer pill consumes. The page used to run its own client-side scan
// loop and only reacted to `currentActivity === 'index'`; that's been
// removed so a single in-flight job is observable from one place.

interface TypeRowData {
  type: string;
  count: number;
  last_indexed_at: string | null;
  stale: boolean;
  error?: string;
}

interface RecordEntry {
  id: string;
  name: string;
  size_bytes: number;
  modified_at?: string;
  status?: string;
}

interface TypeDetail {
  type: string;
  count: number;
  total_bytes: number;
  avg_bytes: number;
  min_bytes: number;
  max_bytes: number;
  scan_ms: number;
  records: RecordEntry[];
}

interface AggregateScanType {
  type: string;
  count: number;
  total_bytes: number;
  avg_bytes: number;
}

interface AggregateScan {
  types: AggregateScanType[];
  grand_total: number;
  scan_ms: number;
}

function fmtBytes(n: number): string {
  if (n === 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function TypeRow({
  row,
  onExpand,
  expanded,
  detail,
  loadingDetail,
  onIndex,
  onClear,
  indexing,
  clearing,
  indexedCount,
  active,
}: {
  row: TypeRowData;
  onExpand: (type: string) => void;
  expanded: boolean;
  detail: TypeDetail | null;
  loadingDetail: boolean;
  onIndex: (type: string) => void;
  onClear: (type: string) => void;
  indexing: boolean;
  clearing: boolean;
  indexedCount: number | null;
  active: boolean;
}) {
  const dimmed = row.count === 0;

  return (
    <>
      <tr
        className={`group cursor-pointer border-b transition-colors hover:bg-accent/20 ${dimmed ? 'opacity-40' : ''} ${active ? 'bg-primary/5' : ''}`}
        onClick={() => row.count > 0 && onExpand(row.type)}
      >
        <td className="w-6 py-2 pl-3 pr-2">
          {row.count > 0 ? (
            expanded ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            )
          ) : null}
        </td>
        <td className="py-2 pr-4 font-mono text-sm">{row.type}</td>
        <td className="py-2 pr-4 text-right tabular-nums text-sm">{row.count}</td>
        <td className="py-2 pr-4 text-right text-xs text-muted-foreground">
          {formatTimeAgo(row.last_indexed_at) ?? '—'}
        </td>
        <td className="py-2 pr-3 text-right text-xs text-muted-foreground">
          {row.error ? (
            <span className="text-destructive">error</span>
          ) : row.stale ? (
            <span className="text-amber-600 dark:text-amber-400">stale</span>
          ) : (
            <span className="text-emerald-600 dark:text-emerald-400">✓</span>
          )}
        </td>
        <td className="w-16 py-2 pr-2 text-right" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-end gap-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 opacity-0 transition-opacity group-hover:opacity-100"
                  disabled={indexing || clearing}
                  onClick={() => onIndex(row.type)}
                >
                  <Database className={`h-3 w-3 ${indexing ? 'animate-pulse' : ''}`} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">
                {indexedCount !== null
                  ? `Indexed ${indexedCount} records`
                  : `Re-index ${row.type}`}
              </TooltipContent>
            </Tooltip>
            {row.count > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5 opacity-0 transition-opacity group-hover:opacity-100 text-destructive hover:text-destructive"
                    disabled={indexing || clearing}
                    onClick={() => onClear(row.type)}
                  >
                    <Trash2 className={`h-3 w-3 ${clearing ? 'animate-pulse' : ''}`} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="left">
                  Clear {row.type} index
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={6} className="bg-muted/30 px-4 py-2">
            {loadingDetail ? (
              <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
                <RefreshCw className="h-3 w-3 animate-spin" />
                Loading records…
              </div>
            ) : detail ? (
              <div className="flex flex-col gap-1">
                <div className="mb-1 flex gap-4 text-xs text-muted-foreground">
                  <span>size: {fmtBytes(detail.total_bytes)}</span>
                  <span>avg: {fmtBytes(detail.avg_bytes)}</span>
                  <span>min: {fmtBytes(detail.min_bytes)}</span>
                  <span>max: {fmtBytes(detail.max_bytes)}</span>
                  <span>scan: {fmtMs(detail.scan_ms)}</span>
                </div>
                <div className="max-h-52 overflow-y-auto rounded border bg-card">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b bg-muted/50 text-muted-foreground">
                        <th className="py-1 pl-3 pr-4 text-left font-medium">uid</th>
                        <th className="py-1 pr-4 text-left font-medium">name</th>
                        <th className="py-1 pr-4 text-right font-medium">size</th>
                        <th className="py-1 pr-3 text-right font-medium">status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.records.map((r) => (
                        <tr key={r.id} className="border-b last:border-0 hover:bg-accent/20">
                          <td className="max-w-[10rem] truncate py-1 pl-3 pr-4 font-mono">{r.id}</td>
                          <td className="max-w-[14rem] truncate py-1 pr-4">{r.name || '(unnamed)'}</td>
                          <td className="py-1 pr-4 text-right tabular-nums">{fmtBytes(r.size_bytes)}</td>
                          <td className="py-1 pr-3 text-right text-muted-foreground">{r.status ?? '—'}</td>
                        </tr>
                      ))}
                      {detail.records.length === 0 && (
                        <tr>
                          <td colSpan={4} className="py-3 text-center text-muted-foreground">
                            No records
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
          </td>
        </tr>
      )}
    </>
  );
}

export function FsRecordsScannerViewer() {
  const { state: indexStatus, refresh: refreshIndexStatus } = useIndexStatus();
  const { currentActivity, progressTable, clearIndex, indexType: indexTypeFromHook } = useSystemTools();
  const clearing = currentActivity === 'clear';
  const refreshing = currentActivity === 'scan' || currentActivity === 'index';

  // Per-type rows are seeded from /fs-records/index-status.per_type[], so the
  // page is never empty as long as anything has been indexed. No client-side
  // scan loop, no separate "Rescan to discover" empty-state click required.
  const typeRows: TypeRowData[] = useMemo(() => {
    if (indexStatus.phase !== 'ready') return [];
    return (indexStatus.status.per_type ?? []).map((pt) => ({
      type: pt.type_name,
      count: pt.entity_count,
      last_indexed_at: pt.last_indexed_at,
      stale: pt.stale,
    }));
  }, [indexStatus]);

  // After any activity transitions to idle, refresh index-status so the rows
  // and the "Last Indexed" column catch up without a page navigation.
  const prevActivity = useRef(currentActivity);
  useEffect(() => {
    if (prevActivity.current !== null && currentActivity === null) {
      refreshIndexStatus();
    }
    prevActivity.current = currentActivity;
  }, [currentActivity, refreshIndexStatus]);

  // Detail cache keyed by type. Loaded on row expand — /fs-records/scan?type=X
  // gives the size breakdown + per-record list, on demand.
  const [details, setDetails] = useState<Record<string, TypeDetail>>({});
  const [loadingDetail, setLoadingDetail] = useState<string | null>(null);
  const [expandedType, setExpandedType] = useState<string | null>(null);

  // Per-type re-index UI state (the row-hover Database button).
  const [indexingTypes, setIndexingTypes] = useState<Set<string>>(new Set());
  const [clearingTypes, setClearingTypes] = useState<Set<string>>(new Set());
  const [indexedResults, setIndexedResults] = useState<Record<string, number>>({});
  const [progressModalOpen, setProgressModalOpen] = useState(false);

  // "Scan Stats" — one-shot aggregate scan that surfaces FS counts + sizes
  // alongside the index-driven row data. The scan call doesn't write to FTS,
  // so it's safe to run any time. Result rendered in a modal.
  const [scanStats, setScanStats] = useState<AggregateScan | null>(null);
  const [scanStatsOpen, setScanStatsOpen] = useState(false);
  const [scanStatsLoading, setScanStatsLoading] = useState(false);

  // Semantic search bar (in-page) state — unchanged from before.
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFilters, setSearchFilters] = useState<SearchFilters>({});
  const { results: searchResults, isLoading: searchLoading, error: searchError, indexerReady } = useRecordSearch(searchQuery, searchFilters);
  const searchActive = searchQuery.trim().length >= 2;

  // Type-table filter bar state.
  const [filterText, setFilterText] = useState('');
  const [showNonEmpty, setShowNonEmpty] = useState(false);

  const detailsRef = useRef(details);
  detailsRef.current = details;

  const handleExpand = useCallback(
    async (typeName: string) => {
      if (expandedType === typeName) {
        setExpandedType(null);
        return;
      }
      setExpandedType(typeName);
      if (detailsRef.current[typeName]) return;
      setLoadingDetail(typeName);
      try {
        const d = await apiClient.get<TypeDetail>(`${SCAN_PATH}?type=${encodeURIComponent(typeName)}`);
        setDetails((prev) => ({ ...prev, [typeName]: d as unknown as TypeDetail }));
      } catch {
        // leave loadingDetail null — row will show nothing
      } finally {
        setLoadingDetail(null);
      }
    },
    [expandedType],
  );

  const handleRefreshIndex = useCallback(async () => {
    // One aggregate call. Backend's FSIndexer.index() walks default_roots()
    // and emits progress_report events (scan phase then index phase) that the
    // footer pill, this page's progress bar, and any other listener all see
    // from the same stream.
    try {
      await apiClient.post(`${BASE}/index`);
    } finally {
      // index-status auto-refreshes on activity→idle via the effect above;
      // detail cache is invalidated so the next expand re-fetches.
      setDetails({});
    }
  }, []);

  const handleClearIndex = useCallback(async () => {
    await clearIndex();
    setIndexedResults({});
    setDetails({});
    refreshIndexStatus();
  }, [clearIndex, refreshIndexStatus]);

  const handleClearType = useCallback(
    async (typeName: string) => {
      setClearingTypes((prev) => new Set(prev).add(typeName));
      try {
        await apiClient.delete(`${BASE}/index?type=${encodeURIComponent(typeName)}`);
        setDetails((prev) => {
          const next = { ...prev };
          delete next[typeName];
          return next;
        });
        refreshIndexStatus();
      } catch {
        // ignore — toast/UX in future
      } finally {
        setClearingTypes((prev) => {
          const next = new Set(prev);
          next.delete(typeName);
          return next;
        });
      }
    },
    [refreshIndexStatus],
  );

  const handleScanStats = useCallback(async () => {
    setScanStatsLoading(true);
    setScanStatsOpen(true);
    try {
      const r = await apiClient.get<AggregateScan>(`${BASE}/scan`);
      setScanStats(r as unknown as AggregateScan);
    } catch {
      setScanStats(null);
    } finally {
      setScanStatsLoading(false);
    }
  }, []);

  // Re-index a single type from inside the Scan Stats modal, then refresh both
  // the modal's stats and the page's per-type rows. Visible "indexing…" state
  // is driven by `indexingTypes` (same as the row-hover indexer), so the
  // modal's row spinner mirrors the page's hover spinner.
  const handleRefreshTypeFromStats = useCallback(
    async (typeName: string) => {
      setIndexingTypes((prev) => new Set(prev).add(typeName));
      try {
        await indexTypeFromHook(typeName);
        // Reload aggregate scan so FS Count / DB Count / Diff reflect the new
        // post-index state.
        try {
          const r = await apiClient.get<AggregateScan>(`${BASE}/scan`);
          setScanStats(r as unknown as AggregateScan);
        } catch {
          // leave existing stats if scan fails
        }
        // Also refresh page-level rows (Last Indexed column, Count).
        refreshIndexStatus();
      } catch {
        // ignore — let progress UI surface the error
      } finally {
        setIndexingTypes((prev) => {
          const next = new Set(prev);
          next.delete(typeName);
          return next;
        });
      }
    },
    [indexTypeFromHook, refreshIndexStatus],
  );

  const handleIndexType = useCallback(
    async (typeName: string) => {
      setIndexingTypes((prev) => new Set(prev).add(typeName));
      try {
        const res = await indexTypeFromHook(typeName);
        setIndexedResults((prev) => ({ ...prev, [typeName]: res.indexed ?? 0 }));
        // Invalidate the cached detail so the row reflects the re-index.
        setDetails((prev) => {
          const next = { ...prev };
          delete next[typeName];
          return next;
        });
      } catch {
        // ignore
      } finally {
        setIndexingTypes((prev) => {
          const next = new Set(prev);
          next.delete(typeName);
          return next;
        });
      }
    },
    [indexTypeFromHook],
  );

  const grandTotal = useMemo(() => typeRows.reduce((s, r) => s + r.count, 0), [typeRows]);

  const filteredRows = useMemo(() => {
    let rows = typeRows;
    if (showNonEmpty) rows = rows.filter((r) => r.count > 0);
    if (filterText.trim()) {
      const q = filterText.trim().toLowerCase();
      rows = rows.filter((r) => r.type.toLowerCase().includes(q));
    }
    return rows;
  }, [typeRows, filterText, showNonEmpty]);

  // Aggregate "last indexed" for the totals bar.
  const lastIndexedAt = indexStatus.phase === 'ready' ? indexStatus.status.last_indexed_at : null;
  const lastIndexedLabel = formatTimeAgo(lastIndexedAt);
  const currentActiveType = progressTable?.current ?? null;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header — toolbar:
            Re-index     (Database/cube)  — POST /fs-records/index (aggregate)
            Scan Stats   (ScanSearch)     — GET /fs-records/scan, panel
            Clear Index  (Trash)          — DELETE /fs-records/index (aggregate)
          Per-type Re-index and Clear live as hover actions on each row. */}
      <div className="flex shrink-0 items-center justify-between border-b px-5 py-3">
        <h1 className="text-sm font-semibold">Records Scanner</h1>
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={() => void handleRefreshIndex()}
                disabled={refreshing || clearing}
              >
                <Database className={`h-3.5 w-3.5 ${refreshing ? 'animate-pulse' : ''}`} />
                {refreshing ? 'Re-indexing…' : 'Re-index'}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Walk the filesystem and re-index all record types
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={() => void handleScanStats()}
                disabled={scanStatsLoading || refreshing || clearing}
              >
                <ScanSearch className={`h-3.5 w-3.5 ${scanStatsLoading ? 'animate-pulse' : ''}`} />
                {scanStatsLoading ? 'Scanning…' : 'Scan Stats'}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Scan the filesystem and report per-type counts and sizes (no write)
            </TooltipContent>
          </Tooltip>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs text-destructive hover:text-destructive" disabled={clearing || refreshing}>
                <Trash2 className={`h-3.5 w-3.5 ${clearing ? 'animate-pulse' : ''}`} />
                {clearing ? 'Clearing…' : 'Clear Index'}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Clear search index?</AlertDialogTitle>
                <AlertDialogDescription>
                  This removes all indexed content from the database and resets the index logs.
                  Records on disk are not affected. You can rebuild the index at any time using Re-index.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={() => void handleClearIndex()}
                >
                  Clear Index
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {/* Single progress bar — driven by useSystemTools, fires for ANY
          activity (scan/index/clear), not just 'index'. Same source as the
          footer pill. */}
      {currentActivity && progressTable && (
        <div className="shrink-0 border-b px-5 py-2">
          <ActivityProgressBar
            table={progressTable}
            onClick={() => setProgressModalOpen(true)}
          />
        </div>
      )}

      {/* Semantic search bar */}
      <div className="shrink-0 border-b px-5 py-2">
        <RecordSearchBar
          compact
          query={searchQuery}
          filters={searchFilters}
          onQueryChange={setSearchQuery}
          onFiltersChange={setSearchFilters}
        />
      </div>

      {/* Totals — sourced from index-status, available on mount. */}
      {indexStatus.phase === 'ready' && (
        <div className="shrink-0 border-b bg-muted/30 px-5 py-2 text-sm">
          <span className="font-medium">{grandTotal.toLocaleString()} records</span>
          {' · '}
          <span className="text-muted-foreground">{typeRows.length} types</span>
          {lastIndexedLabel && (
            <>
              {' · '}
              <span className="text-muted-foreground">last indexed {lastIndexedLabel}</span>
            </>
          )}
        </div>
      )}

      {/* Search results (when query active) OR type-stats table */}
      {searchActive ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          {!indexerReady && (
            <div className="mb-3 flex items-start gap-2 rounded-lg border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
              <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
              <span>Search index is warming up. Run Refresh Index to populate it.</span>
            </div>
          )}
          {searchLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <RefreshCw className="h-4 w-4 animate-spin" />
              Searching…
            </div>
          )}
          {searchError && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {searchError}
            </div>
          )}
          {!searchLoading && !searchError && searchResults.length > 0 && (
            <div className="flex flex-col gap-2">
              {searchResults.map((r) => (
                <SearchResultCard key={r.record_id} result={r} />
              ))}
            </div>
          )}
          {!searchLoading && !searchError && indexerReady && searchResults.length === 0 && (
            <div className="flex flex-col items-center gap-3 py-12 text-center text-muted-foreground">
              <FileSearch className="h-10 w-10 opacity-40" />
              <div>
                <p className="font-medium">No records found</p>
                <p className="text-sm">No results for &ldquo;{searchQuery}&rdquo;</p>
              </div>
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Filter bar */}
          {indexStatus.phase === 'ready' && typeRows.length > 0 && (
            <div className="shrink-0 flex items-center gap-2 border-b px-5 py-2">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  placeholder="Filter types…"
                  className="h-7 pl-8 text-xs"
                />
              </div>
              <Button
                variant={showNonEmpty ? 'secondary' : 'ghost'}
                size="sm"
                className="h-7 text-xs"
                onClick={() => setShowNonEmpty((v) => !v)}
              >
                Non-empty
              </Button>
            </div>
          )}

          {/* Type table */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {indexStatus.phase !== 'ready' && (
              <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                <RefreshCw className="h-3.5 w-3.5 animate-spin" /> Loading index status…
              </div>
            )}
            {indexStatus.phase === 'ready' && typeRows.length === 0 && (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted-foreground">
                <p className="text-sm">
                  Nothing indexed yet.{' '}
                  <button
                    className="font-medium text-foreground underline-offset-2 hover:underline"
                    onClick={() => void handleRefreshIndex()}
                    disabled={refreshing}
                  >
                    Refresh Index
                  </button>
                  {' '}to populate.
                </p>
              </div>
            )}
            {filteredRows.length > 0 && (
              <table className="w-full">
                <thead className="sticky top-0 z-10 border-b bg-card text-xs text-muted-foreground">
                  <tr>
                    <th className="w-6 py-2 pl-3 pr-2" />
                    <th className="py-2 pr-4 text-left font-medium">Type</th>
                    <th className="py-2 pr-4 text-right font-medium">Count</th>
                    <th className="py-2 pr-4 text-right font-medium">Last Indexed</th>
                    <th className="py-2 pr-3 text-right font-medium">Status</th>
                    <th className="w-16 py-2 pr-2" />
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map((r) => (
                    <TypeRow
                      key={r.type}
                      row={r}
                      expanded={expandedType === r.type}
                      detail={details[r.type] ?? null}
                      loadingDetail={loadingDetail === r.type}
                      onExpand={handleExpand}
                      onIndex={handleIndexType}
                      onClear={handleClearType}
                      indexing={indexingTypes.has(r.type)}
                      clearing={clearingTypes.has(r.type)}
                      indexedCount={indexedResults[r.type] ?? null}
                      active={(refreshing || clearing) && currentActiveType === r.type}
                    />
                  ))}
                </tbody>
              </table>
            )}
            {indexStatus.phase === 'ready' && typeRows.length > 0 && filteredRows.length === 0 && (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                No types match filter
              </div>
            )}
          </div>
        </>
      )}

      {/* Progress modal — shared with the footer pill's click target. */}
      <ActivityProgressModal
        open={progressModalOpen}
        onOpenChange={setProgressModalOpen}
        table={progressTable}
        title={
          currentActivity === 'scan'
            ? 'Scanning'
            : currentActivity === 'index'
              ? 'Indexing'
              : currentActivity === 'clear'
                ? 'Clearing index'
                : 'Activity'
        }
      />

      {/* Scan Stats modal — one-shot aggregate scan report. */}
      <Dialog open={scanStatsOpen} onOpenChange={setScanStatsOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Scan Stats</DialogTitle>
            <DialogDescription>
              Walked the filesystem without writing. Counts and sizes reflect what
              is on disk right now; compare against the per-type rows to see drift.
            </DialogDescription>
          </DialogHeader>
          {scanStatsLoading ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <RefreshCw className="h-4 w-4 animate-spin" /> Scanning…
            </div>
          ) : scanStats ? (
            <div className="flex flex-col gap-2">
              <div className="text-sm">
                <span className="font-medium">{scanStats.grand_total.toLocaleString()} records on disk</span>
                {' · '}
                <span className="text-muted-foreground">{scanStats.types.length} types · {fmtMs(scanStats.scan_ms)}</span>
              </div>
              <div className="max-h-[55vh] overflow-y-auto rounded border bg-card">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b bg-muted/50 text-muted-foreground">
                      <th className="py-1 pl-3 pr-4 text-left font-medium">Type</th>
                      <th className="py-1 pr-4 text-right font-medium">FS Count</th>
                      <th className="py-1 pr-4 text-right font-medium">DB Count</th>
                      <th className="py-1 pr-4 text-right font-medium">Diff</th>
                      <th className="py-1 pr-4 text-right font-medium">Size</th>
                      <th className="w-10 py-1 pr-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {scanStats.types
                      .filter((t) => t.count > 0)
                      .sort((a, b) => b.count - a.count)
                      .map((t) => {
                        const dbCount = typeRows.find((r) => r.type === t.type)?.count ?? 0;
                        const diff = t.count - dbCount;
                        const isIndexing = indexingTypes.has(t.type);
                        return (
                          <tr key={t.type} className="group border-b last:border-0">
                            <td className="py-1 pl-3 pr-4 font-mono">{t.type}</td>
                            <td className="py-1 pr-4 text-right tabular-nums">{t.count}</td>
                            <td className="py-1 pr-4 text-right tabular-nums text-muted-foreground">{dbCount}</td>
                            <td className={`py-1 pr-4 text-right tabular-nums ${diff > 0 ? 'text-amber-600 dark:text-amber-400' : diff < 0 ? 'text-destructive' : 'text-muted-foreground'}`}>
                              {diff === 0 ? '—' : diff > 0 ? `+${diff}` : diff}
                            </td>
                            <td className="py-1 pr-4 text-right tabular-nums text-muted-foreground">{fmtBytes(t.total_bytes)}</td>
                            <td className="w-10 py-1 pr-3 text-right">
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-5 w-5 opacity-0 transition-opacity group-hover:opacity-100"
                                    disabled={isIndexing}
                                    onClick={() => void handleRefreshTypeFromStats(t.type)}
                                  >
                                    <RefreshCw className={`h-3 w-3 ${isIndexing ? 'animate-spin' : ''}`} />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent side="left">
                                  {isIndexing ? `Re-indexing ${t.type}…` : `Re-index ${t.type} and refresh stats`}
                                </TooltipContent>
                              </Tooltip>
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-muted-foreground">
                <span className="text-amber-600 dark:text-amber-400">+N</span> = files on disk not yet indexed;{' '}
                <span className="text-destructive">-N</span> = DB rows whose source file is gone (orphans).
              </p>
            </div>
          ) : (
            <div className="py-6 text-sm text-destructive">Scan failed.</div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
