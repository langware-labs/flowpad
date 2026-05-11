import apiClient from '@sdk/client';
import { RecordSearchBar } from '@src/components/record-search-bar/RecordSearchBar';
import { SearchResultCard } from '@src/components/record-search-bar/SearchResultCard';
import { ActivityProgressBar, ActivityProgressModal } from '@src/components/search-index/ActivityProgressModal';
import { useSystemTools } from '@src/hooks/use-system-tools';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, ChevronDown, ChevronRight, Search, Database, FileSearch, Trash2 } from 'lucide-react';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@src/components/ui/alert-dialog';
import { SearchFilters, useRecordSearch } from '@src/hooks/use-record-search';

const BASE = '/graph/compute_node/@local/fs-records';
const SCAN_PATH = `${BASE}/scan`;

const SCAN_SKIP_TYPES = new Set(['claude_debug_log']);

interface TypeStats {
  type: string;
  count: number;
  total_bytes: number;
  avg_bytes: number;
  scan_ms: number;
  last_scan_at?: string;
  error?: string;
}

interface RecordEntry {
  id: string;
  name: string;
  size_bytes: number;
  modified_at?: string;
  status?: string;
}

interface TypeDetail extends TypeStats {
  records: RecordEntry[];
  min_bytes: number;
  max_bytes: number;
}

interface ScanResult {
  types: TypeStats[];
  grand_total: number;
  scan_ms: number;
}

import type { IndexProgressTable } from '@sdk';

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

function fmtAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}


function TypeRow({
  stats,
  onExpand,
  expanded,
  detail,
  loadingDetail,
  onIndex,
  indexing,
  indexedCount,
}: {
  stats: TypeStats;
  onExpand: (type: string) => void;
  expanded: boolean;
  detail: TypeDetail | null;
  loadingDetail: boolean;
  onIndex: (type: string) => void;
  indexing: boolean;
  indexedCount: number | null;
}) {
  const dimmed = stats.count === 0;

  return (
    <>
      <tr
        className={`group cursor-pointer border-b transition-colors hover:bg-accent/20 ${dimmed ? 'opacity-40' : ''}`}
        onClick={() => stats.count > 0 && onExpand(stats.type)}
      >
        <td className="w-6 py-2 pl-3 pr-2">
          {stats.count > 0 ? (
            expanded ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            )
          ) : null}
        </td>
        <td className="py-2 pr-4 font-mono text-sm">{stats.type}</td>
        <td className="py-2 pr-4 text-right tabular-nums text-sm">{stats.count}</td>
        <td className="py-2 pr-4 text-right tabular-nums text-sm text-muted-foreground">
          {fmtBytes(stats.total_bytes)}
        </td>
        <td className="py-2 pr-4 text-right tabular-nums text-sm text-muted-foreground">
          {stats.count > 0 ? fmtBytes(stats.avg_bytes) : '—'}
        </td>
        <td className="py-2 pr-4 text-right text-xs text-muted-foreground">
          {stats.last_scan_at ? fmtAgo(stats.last_scan_at) : '—'}
        </td>
        <td className="py-2 pr-3 text-right text-xs text-muted-foreground">
          {stats.error ? (
            <span className="text-destructive">error</span>
          ) : (
            <span className="text-emerald-600 dark:text-emerald-400">✓</span>
          )}
        </td>
        <td className="w-8 py-2 pr-2 text-right" onClick={(e) => e.stopPropagation()}>
          {stats.count > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 opacity-0 transition-opacity group-hover:opacity-100"
                  disabled={indexing}
                  onClick={() => onIndex(stats.type)}
                >
                  <Database className={`h-3 w-3 ${indexing ? 'animate-pulse' : ''}`} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">
                {indexedCount !== null
                  ? `Indexed ${indexedCount} records`
                  : `Index ${stats.type}`}
              </TooltipContent>
            </Tooltip>
          )}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={8} className="bg-muted/30 px-4 py-2">
            {loadingDetail ? (
              <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
                <RefreshCw className="h-3 w-3 animate-spin" />
                Loading records…
              </div>
            ) : detail ? (
              <div className="flex flex-col gap-1">
                <div className="mb-1 flex gap-4 text-xs text-muted-foreground">
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
  const [result, setResult] = useState<ScanResult | null>(null);
  const [expandedType, setExpandedType] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, TypeDetail>>({});
  const [loadingDetail, setLoadingDetail] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  // Semantic search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFilters, setSearchFilters] = useState<SearchFilters>({});
  const { results: searchResults, isLoading: searchLoading, error: searchError, indexerReady } = useRecordSearch(searchQuery, searchFilters);
  const searchActive = searchQuery.trim().length >= 2;

  // Filter state (type-table filter bar)
  const [filterText, setFilterText] = useState('');
  const [showNonEmpty, setShowNonEmpty] = useState(false);

  // Global system tools state (index / clear)
  const { currentActivity, progressTable, clearIndex, indexType: indexTypeFromHook, indexTypes } = useSystemTools();
  const clearing = currentActivity === 'clear';
  const indexingAll = currentActivity === 'index';

  const [indexingTypes, setIndexingTypes] = useState<Set<string>>(new Set());
  const [indexedResults, setIndexedResults] = useState<Record<string, number>>({});
  const [progressModalOpen, setProgressModalOpen] = useState(false);

  // Scan progress state (local — viewer-only)
  const [scanProgress, setScanProgress] = useState<IndexProgressTable | null>(null);

  // Build a snapshot of the current per-type scan state. Mirrors the backend
  // scan() output: total=0 (unknown), each row's done==total (already counted).
  const buildScanTable = useCallback(
    (types: string[], counts: Record<string, number>, current: string | null): IndexProgressTable => ({
      job_name: 'scan',
      rows: types.map((t) => ({
        type_name: t,
        done: counts[t] ?? 0,
        total: counts[t] ?? 0,
        errors: 0,
        skipped: 0,
      })),
      current,
      done: Object.values(counts).reduce((s, n) => s + n, 0),
      total: 0,
      text: current === null && Object.keys(counts).length === types.length ? 'complete' : null,
      ts: new Date().toISOString(),
    }),
    [],
  );
  const [scanModalOpen, setScanModalOpen] = useState(false);

  const handleClearIndex = useCallback(async () => {
    await clearIndex();
    setIndexedResults({});
  }, [clearIndex]);

  const runScan = useCallback(async (trigger: string = 'auto') => {
    cancelledRef.current = false;
    setScanning(true);
    setResult(null);
    setError(null);
    setExpandedType(null);
    setDetails({});
    setIndexedResults({});
    setScanProgress(null);

    try {
      // 1. Get registered type list (fast, no disk scan)
      const typesData = await apiClient.get<{ types: string[] }>(BASE);
      if (cancelledRef.current) return;
      const types = ((typesData as unknown as { types: string[] }).types ?? []).filter(
        (t) => !SCAN_SKIP_TYPES.has(t),
      );

      // 2. Scan each type individually, showing progress
      const counts: Record<string, number> = {};
      setScanProgress(buildScanTable(types, counts, null));

      const typeResults: TypeStats[] = [];
      let grandTotal = 0;
      const tStart = performance.now();

      for (const typeName of types) {
        if (cancelledRef.current) return;
        setScanProgress(buildScanTable(types, counts, typeName));

        try {
          const detail = await apiClient.get<TypeDetail>(`${SCAN_PATH}?type=${encodeURIComponent(typeName)}&trigger=${trigger}`);
          const d = detail as unknown as TypeDetail;
          typeResults.push({ type: typeName, count: d.count, total_bytes: d.total_bytes, avg_bytes: d.avg_bytes, scan_ms: d.scan_ms, last_scan_at: d.last_scan_at, error: d.error });
          grandTotal += d.count;
          counts[typeName] = d.count;
          // Cache detail so expanding rows is instant
          setDetails((prev) => ({ ...prev, [typeName]: d }));
        } catch {
          typeResults.push({ type: typeName, count: 0, total_bytes: 0, avg_bytes: 0, scan_ms: 0, error: 'scan failed' });
          counts[typeName] = 0;
        }
      }

      setScanProgress(buildScanTable(types, counts, null));

      if (!cancelledRef.current) {
        setResult({ types: typeResults, grand_total: grandTotal, scan_ms: Math.round(performance.now() - tStart) });
      }
    } catch (err: unknown) {
      if (!cancelledRef.current) {
        setError(err instanceof Error ? err.message : 'Scan failed');
      }
    } finally {
      setScanning(false);
    }
  }, [buildScanTable]);

  useEffect(() => {
    return () => {
      cancelledRef.current = true;
    };
  }, [runScan]);

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

  const indexType = useCallback(async (typeName: string) => {
    setIndexingTypes((prev) => new Set(prev).add(typeName));
    try {
      const res = await indexTypeFromHook(typeName);
      setIndexedResults((prev) => ({ ...prev, [typeName]: res.indexed ?? 0 }));
    } catch {
      // ignore
    } finally {
      setIndexingTypes((prev) => {
        const next = new Set(prev);
        next.delete(typeName);
        return next;
      });
    }
  }, [indexTypeFromHook]);

  const typeRows = result?.types ?? [];
  const grandTotal = result?.grand_total ?? 0;
  const totalBytes = useMemo(() => typeRows.reduce((s, t) => s + t.total_bytes, 0), [typeRows]);

  const indexAll = useCallback(async () => {
    if (indexingAll) return;

    const types = typeRows.filter((t) => t.count > 0).map((t) => t.type);
    if (types.length === 0) return;

    const results = await indexTypes(types);
    setIndexedResults((prev) => ({ ...prev, ...results }));
  }, [typeRows, indexingAll, indexTypes]);

  const filteredRows = useMemo(() => {
    let rows = typeRows;
    if (showNonEmpty) rows = rows.filter((r) => r.count > 0);
    if (filterText.trim()) {
      const q = filterText.trim().toLowerCase();
      rows = rows.filter((r) => r.type.toLowerCase().includes(q));
    }
    return rows;
  }, [typeRows, filterText, showNonEmpty]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b px-5 py-3">
        <h1 className="text-sm font-semibold">Records Scanner</h1>
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={indexAll}
                disabled={indexingAll || scanning || !result}
              >
                <Database className={`h-3.5 w-3.5 ${indexingAll ? 'animate-pulse' : ''}`} />
                {indexingAll ? 'Indexing…' : 'Index All'}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {indexedResults.__all__ !== undefined
                ? `Last run: ${indexedResults.__all__} indexed`
                : 'Re-index all record types'}
            </TooltipContent>
          </Tooltip>
          <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => void runScan('manual')} disabled={scanning}>
            <RefreshCw className={`h-3.5 w-3.5 ${scanning ? 'animate-spin' : ''}`} />
            Rescan
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs text-destructive hover:text-destructive" disabled={clearing}>
                <Trash2 className="h-3.5 w-3.5" />
                Clear Index
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Clear search index?</AlertDialogTitle>
                <AlertDialogDescription>
                  This removes all indexed content from the database and resets the index logs.
                  Records on disk are not affected. You can rebuild the index at any time using Index All.
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

      {/* Scan progress bar */}
      {scanProgress && (
        <div className="shrink-0 border-b px-5 py-2">
          <ActivityProgressBar
            table={scanProgress}
            onClick={() => setScanModalOpen(true)}
          />
        </div>
      )}

      {/* Index progress bar */}
      {currentActivity === 'index' && progressTable && (
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

      {/* Scanning indicator */}
      {scanning && (
        <div className="shrink-0 border-b px-5 py-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <RefreshCw className="h-4 w-4 animate-spin" />
            Scanning all record types…
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="shrink-0 border-b bg-destructive/10 px-5 py-3 text-sm text-destructive">{error}</div>
      )}

      {/* Totals */}
      {result && (
        <div className="shrink-0 border-b bg-muted/30 px-5 py-2 text-sm">
          <span className="font-medium">{grandTotal.toLocaleString()} records</span>
          {' · '}
          <span className="text-muted-foreground">{fmtBytes(totalBytes)}</span>
          {' · '}
          <span className="text-muted-foreground">{typeRows.length} types</span>
          {' · '}
          <span className="text-muted-foreground">{fmtMs(result.scan_ms)}</span>
        </div>
      )}

      {/* Search results (when query active) OR stats table + filter bar */}
      {searchActive ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          {!indexerReady && (
            <div className="mb-3 flex items-start gap-2 rounded-lg border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
              <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
              <span>Search index is warming up. Run Index All to populate it.</span>
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
          {result && (
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

          {/* Stats table */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {!scanning && !result && !error && (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted-foreground">
                <p className="text-sm">
                  <button
                    className="font-medium text-foreground underline-offset-2 hover:underline"
                    onClick={() => void runScan('manual')}
                  >
                    Rescan
                  </button>
                  {' '}to discover records on disk.
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
                    <th className="py-2 pr-4 text-right font-medium">Size</th>
                    <th className="py-2 pr-4 text-right font-medium">Avg</th>
                    <th className="py-2 pr-4 text-right font-medium">Last Scan</th>
                    <th className="py-2 pr-3 text-right font-medium">Status</th>
                    <th className="w-8 py-2 pr-2" />
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map((s) => (
                    <TypeRow
                      key={s.type}
                      stats={s}
                      expanded={expandedType === s.type}
                      detail={details[s.type] ?? null}
                      loadingDetail={loadingDetail === s.type}
                      onExpand={handleExpand}
                      onIndex={indexType}
                      indexing={indexingTypes.has(s.type)}
                      indexedCount={indexedResults[s.type] ?? null}
                    />
                  ))}
                </tbody>
              </table>
            )}
            {result && filteredRows.length === 0 && typeRows.length > 0 && (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                No types match filter
              </div>
            )}
          </div>
        </>
      )}

      {/* Scan progress modal */}
      <ActivityProgressModal
        open={scanModalOpen}
        onOpenChange={setScanModalOpen}
        table={scanProgress}
        title="Scan Progress"
      />

      {/* Index progress modal */}
      <ActivityProgressModal
        open={progressModalOpen}
        onOpenChange={setProgressModalOpen}
        table={progressTable}
        title="Indexing Progress"
      />
    </div>
  );
}
