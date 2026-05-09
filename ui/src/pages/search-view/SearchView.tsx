import { RecordSearchBar } from '@src/components/record-search-bar/RecordSearchBar';
import { SearchResultCard } from '@src/components/record-search-bar/SearchResultCard';
import { SearchCalibrationPanel } from '@src/components/search-calibration/SearchCalibrationPanel';
import { ActivityProgressModal } from '@src/components/search-index/ActivityProgressModal';
import { IndexNowModal } from '@src/components/search-index/IndexNowModal';
import { IndexRecommendedBanner } from '@src/components/search-index/IndexRecommendedBanner';
import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@src/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { dataManager, systemTools } from '@sdk';
import { SearchCalibration, SearchFilters, loadStoredCalibration, saveCalibration, useRecordSearch } from '@src/hooks/use-record-search';
import { useIndexStatus } from '@src/hooks/use-index-status';
import { useSystemTools } from '@src/hooks/use-system-tools';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { SystemActivity, IndexProgressTable } from '@sdk';
import { AlertCircle, FileSearch, Loader2, Menu, PackageSearch, SlidersHorizontal } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

const LS_KEY = 'flowpad-search-filters';
const _INDEX_APPROVED_KEY = 'flowpad-index-approved';
const _SCAN_DISMISSED_KEY = 'flowpad-scan-dismissed';

function activityPhaseLabel(activity: SystemActivity): string {
  switch (activity) {
    case 'archive': return 'Archiving…';
    case 'clear': return 'Clearing index…';
    case 'load_from_archive': return 'Restoring…';
    case 'scan': return 'Scanning';
    case 'index': return 'Indexing';
  }
}

function activityLabel(activity: SystemActivity, table: IndexProgressTable | null): string {
  const counts = table
    ? (table.total > 0 ? `${table.done}/${table.total}` : `${table.done}`)
    : null;
  switch (activity) {
    case 'archive': return 'Archiving…';
    case 'clear': return 'Clearing index…';
    case 'load_from_archive': return 'Restoring…';
    case 'scan':
      return counts ? `Scanning… ${counts}` : 'Scanning…';
    case 'index':
      return counts ? `Indexing… ${counts}` : 'Indexing…';
  }
}

function loadStoredFilters(): SearchFilters {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) ?? 'null') ?? {};
  } catch {
    return {};
  }
}

function saveFilters(f: SearchFilters) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(f)); } catch { /* ignore */ }
}

function clearStoredFilters() {
  try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
}

function SkeletonCard() {
  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card px-4 py-3 animate-pulse">
      <div className="flex items-center gap-2">
        <div className="h-4 w-14 rounded bg-muted" />
        <div className="h-4 flex-1 rounded bg-muted" />
        <div className="h-4 w-12 rounded bg-muted" />
      </div>
      <div className="h-3 w-3/4 rounded bg-muted" />
    </div>
  );
}

type IndexState = 'loading' | 'never_indexed' | 'denied' | 'stale' | 'ok';

/**
 * SearchView — full-width record semantic search page.
 * Reads initial query from currentDock.options.q and updates URL on change.
 * URL: /dock/search?q=...&record_type=...&status=...&scope=...
 */
export function SearchView() {
  const { currentDock, navigation } = useDockNavigation();

  // Initialize from URL options, falling back to localStorage
  const [query, setQuery] = useState(() => currentDock?.options?.q ?? '');
  const [filters, setFilters] = useState<SearchFilters>(() => {
    const stored = loadStoredFilters();
    const url: SearchFilters = {
      record_type: currentDock?.options?.record_type,
      status: currentDock?.options?.status,
      scope: currentDock?.options?.scope,
      time_preset: currentDock?.options?.time_preset as SearchFilters['time_preset'],
      time_start: currentDock?.options?.time_start,
      time_end: currentDock?.options?.time_end,
    };
    const hasUrlFilters = Object.values(url).some(Boolean);
    return hasUrlFilters ? url : stored;
  });
  const [calibration, setCalibration] = useState<SearchCalibration>(loadStoredCalibration);

  const { currentActivity, progressTable, busy, resetAndRescan } = useSystemTools();
  const [progressOpen, setProgressOpen] = useState(false);

  // Re-seed progress state from backend after page refresh so the footer
  // indicator reappears mid-job. The modal stays closed until the user opens
  // it explicitly via the footer indicator.
  useEffect(() => {
    void systemTools.refreshActivityStatus();
  }, []);

  const handleRebuildIndex = useCallback(() => {
    void resetAndRescan();
  }, [resetAndRescan]);

  const [scanInfo, setScanInfo] = useState(() => dataManager.scanInfo);
  useEffect(() => dataManager.onScanInfoChange(setScanInfo), []);

  // Index status
  const statusState = useIndexStatus();
  const [indexState, setIndexState] = useState<IndexState>('loading');
  const [modalOpen, setModalOpen] = useState(false);

  useEffect(() => {
    if (statusState.phase !== 'ready') return;
    const { never_indexed, stale } = statusState.status;
    if (never_indexed) setIndexState('never_indexed');
    else if (stale) setIndexState('stale');
    else setIndexState('ok');
  }, [statusState]);

  useEffect(() => {
    if (indexState === 'never_indexed' && !localStorage.getItem(_INDEX_APPROVED_KEY) && !sessionStorage.getItem(_SCAN_DISMISSED_KEY)) setModalOpen(true);
  }, [indexState]);

  // Sync from URL when dock options change (e.g., browser back/forward)
  useEffect(() => {
    const urlQ = currentDock?.options?.q ?? '';
    setQuery(urlQ);
    const urlFilters: SearchFilters = {
      record_type: currentDock?.options?.record_type,
      status: currentDock?.options?.status,
      scope: currentDock?.options?.scope,
      time_preset: currentDock?.options?.time_preset as SearchFilters['time_preset'],
      time_start: currentDock?.options?.time_start,
      time_end: currentDock?.options?.time_end,
    };
    const hasUrlFilters = Object.values(urlFilters).some(Boolean);
    setFilters(hasUrlFilters ? urlFilters : loadStoredFilters());
  }, [
    currentDock?.options?.q,
    currentDock?.options?.record_type,
    currentDock?.options?.status,
    currentDock?.options?.scope,
    currentDock?.options?.time_preset,
    currentDock?.options?.time_start,
    currentDock?.options?.time_end,
  ]);

  const { results, isLoading, error, indexerReady, latencyMs } = useRecordSearch(query, filters, calibration);

  // Push query/filter changes to URL so browser history and sharing work
  const handleQueryChange = useCallback(
    (q: string) => {
      if (indexState === 'never_indexed' || indexState === 'denied') {
        setModalOpen(true);
        return;
      }
      setQuery(q);
      navigation.openSearch(q || undefined, filters);
    },
    [indexState, navigation, filters],
  );

  const handleFiltersChange = useCallback(
    (f: SearchFilters) => {
      if (indexState === 'never_indexed' || indexState === 'denied') {
        setModalOpen(true);
        return;
      }
      setFilters(f);
      saveFilters(f);
      navigation.openSearch(query || undefined, f);
    },
    [indexState, navigation, query],
  );

  const handleClearAll = useCallback(() => {
    clearStoredFilters();
    setFilters({});
    navigation.openSearch(query || undefined, {});
  }, [navigation, query]);

  const handleCalibrationChange = useCallback((c: SearchCalibration) => {
    setCalibration(c);
    saveCalibration(c);
  }, []);

  return (
    <div className="flex h-full flex-col gap-4 overflow-hidden p-6" data-testid="search-view">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3">
        <h1 className="text-lg font-semibold">Search</h1>
        {results.length > 0 && !isLoading && (
          <Badge variant="secondary" className="text-xs">
            {results.length} result{results.length !== 1 ? 's' : ''}
          </Badge>
        )}
        {latencyMs != null && !isLoading && (
          <span className="text-xs text-muted-foreground">⚡ {latencyMs} ms</span>
        )}
        {scanInfo?.total_indexed != null && (
          <span className="text-xs text-muted-foreground">
            {scanInfo.total_indexed.toLocaleString()} indexed
          </span>
        )}
        {indexState === 'stale' && (
          <Badge variant="outline" className="text-xs text-amber-600 border-amber-400">
            refresh recommended
          </Badge>
        )}
        <div className="ml-auto">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7">
                <Menu className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => navigation.openDock(DockPointer.forFsRecordsScanner())}>
                Records Scan
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleCalibrationChange({ ...calibration, visible: !calibration.visible })}>
                <SlidersHorizontal className="mr-2 h-4 w-4" />
                Search Calibration
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Search bar row — with refresh button */}
      <div className="shrink-0 flex items-start gap-2">
        <div
          className="flex-1"
          onClick={indexState === 'denied' ? () => setModalOpen(true) : undefined}
        >
          <RecordSearchBar
            compact={false}
            query={query}
            filters={filters}
            onQueryChange={handleQueryChange}
            onFiltersChange={handleFiltersChange}
            onClearAll={handleClearAll}
          />
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 shrink-0 mt-0.5"
              onClick={handleRebuildIndex}
              disabled={busy}
              data-testid="rebuild-index"
            >
              <PackageSearch className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Refresh search data</TooltipContent>
        </Tooltip>
      </div>

      {/* Activity strip — shown while any system activity is running */}
      {currentActivity && (
        <button
          onClick={() => setProgressOpen(true)}
          className="shrink-0 flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-1.5 text-xs hover:bg-muted/60 transition-colors w-full text-left"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0 text-primary" />
          <span className="text-muted-foreground shrink-0">{activityPhaseLabel(currentActivity)}</span>
          {progressTable?.current && (
            <span className="font-mono text-foreground truncate max-w-[180px]">
              {progressTable.current}
            </span>
          )}
          {progressTable && (
            <>
              <span className="ml-auto text-muted-foreground shrink-0 tabular-nums">
                {progressTable.total > 0
                  ? `${progressTable.done.toLocaleString()}/${progressTable.total.toLocaleString()}`
                  : progressTable.done.toLocaleString()}
              </span>
              {progressTable.total > 0 && (
                <div className="h-1 w-20 rounded-full bg-muted overflow-hidden shrink-0">
                  <div
                    className="h-full bg-primary rounded-full transition-all"
                    style={{ width: `${(progressTable.done / progressTable.total) * 100}%` }}
                  />
                </div>
              )}
            </>
          )}
        </button>
      )}

      {/* Stale banner — between search bar and calibration panel */}
      {indexState === 'stale' && statusState.phase === 'ready' && (
        <IndexRecommendedBanner
          lastIndexedAt={statusState.status.last_indexed_at!}
          types={statusState.status.default_types}
          onComplete={() => setIndexState('ok')}
        />
      )}

      {/* Calibration panel */}
      {calibration.visible && (
        <SearchCalibrationPanel
          calibration={calibration}
          onChange={handleCalibrationChange}
          latencyMs={latencyMs}
        />
      )}

      {/* Results */}
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="search-results">
        {!indexerReady && (
          <div className="flex items-start gap-2 rounded-lg border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Search index is warming up. Results will appear once indexing is complete.</span>
          </div>
        )}

        {isLoading && (
          <div className="flex flex-col gap-2">
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </div>
        )}

        {!isLoading && error && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {!isLoading && !error && (query.trim().length >= 2 || filters.record_type || filters.status || filters.scope || filters.time_preset) && results.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-12 text-center text-muted-foreground">
            <FileSearch className="h-10 w-10 opacity-40" />
            <div>
              <p className="font-medium">No records found</p>
              {query.trim() ? (
                <p className="text-sm">No records found for &ldquo;{query}&rdquo;</p>
              ) : (
                <p className="text-sm">No records of this type</p>
              )}
            </div>
          </div>
        )}

        {!isLoading && !error && results.length > 0 && (
          <div className="flex flex-col gap-2">
            {results.map((r) => (
              <SearchResultCard key={r.record_id} result={r} />
            ))}
          </div>
        )}
      </div>

      {/* First-time index modal */}
      {statusState.phase === 'ready' && (
        <IndexNowModal
          open={modalOpen}
          types={statusState.status.default_types}
          onComplete={() => { localStorage.setItem(_INDEX_APPROVED_KEY, '1'); setModalOpen(false); setIndexState('ok'); }}
          onDeny={() => { sessionStorage.setItem(_SCAN_DISMISSED_KEY, '1'); setModalOpen(false); setIndexState('denied'); }}
        />
      )}

      {/* Activity progress detail modal */}
      <ActivityProgressModal
        open={progressOpen}
        onOpenChange={setProgressOpen}
        table={progressTable}
        title={currentActivity ? activityLabel(currentActivity, progressTable) : 'Activity'}
      />
    </div>
  );
}

export default SearchView;
