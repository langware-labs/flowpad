import { RecordSearchBar } from '@src/components/record-search-bar/RecordSearchBar';
import { SearchResultCard } from '@src/components/record-search-bar/SearchResultCard';
import { SearchScopeToggle } from '@src/components/record-search-bar/SearchScopeToggle';
import { SearchCalibrationPanel } from '@src/components/search-calibration/SearchCalibrationPanel';
import { ActivityIndicator } from '@src/components/search-index/ActivityIndicator';
import { IndexNowModal } from '@src/components/search-index/IndexNowModal';
import { IndexRecommendedBanner } from '@src/components/search-index/IndexRecommendedBanner';
import {
  INDEX_BUILD_LABEL,
  INDEX_PROMPT_DESCRIPTION,
  INDEX_PROMPT_TITLE,
} from '@src/components/search-index/index-copy';
import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@src/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { dataContext, dataManager, systemTools } from '@sdk';
import {
  SearchCalibration,
  SearchFilters,
  loadStoredCalibration,
  saveCalibration,
  useRecordSearch,
} from '@src/hooks/use-record-search';
import { useIndexStatus } from '@src/hooks/use-index-status';
import { useSystemTools } from '@src/hooks/use-system-tools';
import { useSearchScopeToggle } from '@src/hooks/use-global-search-scope';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { AlertCircle, FileSearch, Menu, PackageSearch, SlidersHorizontal } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Trans } from '@lingui/react/macro';

const LS_KEY = 'flowpad-search-filters';

function loadStoredFilters(): SearchFilters {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) ?? 'null') ?? {};
  } catch {
    return {};
  }
}

function saveFilters(f: SearchFilters) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(f));
  } catch {
    /* ignore */
  }
}

function clearStoredFilters() {
  try {
    localStorage.removeItem(LS_KEY);
  } catch {
    /* ignore */
  }
}

function SkeletonCard() {
  return (
    <div className="flex animate-pulse flex-col gap-2 rounded-lg border bg-card px-4 py-3">
      <div className="flex items-center gap-2">
        <div className="h-4 w-14 rounded bg-muted" />
        <div className="h-4 flex-1 rounded bg-muted" />
        <div className="h-4 w-12 rounded bg-muted" />
      </div>
      <div className="h-3 w-3/4 rounded bg-muted" />
    </div>
  );
}

type IndexState = 'loading' | 'never_indexed' | 'stale' | 'ok';

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

  const { busy, resetAndRescan } = useSystemTools();

  const currentProjectId = dataContext.project?.id ?? null;
  const {
    scope,
    isLoading: searchScopeLoading,
    mode: searchScopeMode,
    setMode: setSearchScopeMode,
    allProjectCount,
    currentProjectAvailable,
  } = useSearchScopeToggle(currentProjectId);

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

  // Index status — derived, not mirrored: `statusState` is the single source of
  // truth, and a completed build calls `refreshStatus()` to re-read it.
  const { state: statusState, refresh: refreshStatus } = useIndexStatus();
  const [modalOpen, setModalOpen] = useState(false);

  const indexState: IndexState =
    statusState.phase !== 'ready'
      ? 'loading'
      : statusState.status.never_indexed
        ? 'never_indexed'
        : statusState.status.stale
          ? 'stale'
          : 'ok';

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

  const searchQueryForRequest = searchScopeLoading ? '' : query;
  const searchFiltersForRequest = searchScopeLoading ? {} : filters;
  const {
    results,
    isLoading: searchLoading,
    error,
    indexerReady,
    latencyMs,
  } = useRecordSearch(searchQueryForRequest, searchFiltersForRequest, calibration, scope);
  const isLoading = searchScopeLoading || searchLoading;
  // The user has actually asked for something — an empty result is worth reporting.
  const hasActiveQuery = Boolean(
    query.trim().length >= 2 || filters.record_type || filters.status || filters.scope || filters.time_preset,
  );

  // Push query/filter changes to URL so browser history and sharing work
  const handleQueryChange = useCallback(
    (q: string) => {
      setQuery(q);
      navigation.openSearch(q || undefined, filters);
    },
    [navigation, filters],
  );

  const handleFiltersChange = useCallback(
    (f: SearchFilters) => {
      setFilters(f);
      saveFilters(f);
      navigation.openSearch(query || undefined, f);
    },
    [navigation, query],
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
        <h1 className="text-lg font-semibold">
          <Trans>Search</Trans>
        </h1>
        {results.length > 0 && !isLoading && (
          <Badge variant="secondary" className="text-xs">
            {results.length} result{results.length !== 1 ? 's' : ''}
          </Badge>
        )}
        {latencyMs != null && !isLoading && <span className="text-xs text-muted-foreground">⚡ {latencyMs} ms</span>}
        {scanInfo?.total_indexed != null && (
          <span className="text-xs text-muted-foreground">
            {scanInfo.total_indexed.toLocaleString()} <Trans>indexed</Trans>
          </span>
        )}
        {indexState === 'stale' && (
          <Badge variant="outline" className="border-amber-400 text-xs text-amber-600">
            <Trans>refresh recommended</Trans>
          </Badge>
        )}
        <div className="ms-auto">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7">
                <Menu className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => navigation.openDock(DockPointer.forFsRecordsScanner())}>
                <Trans>Records Scan</Trans>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => handleCalibrationChange({ ...calibration, visible: !calibration.visible })}
              >
                <SlidersHorizontal className="me-2 h-4 w-4" />
                <Trans>Search Calibration</Trans>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="shrink-0">
        <SearchScopeToggle
          value={searchScopeMode}
          onChange={setSearchScopeMode}
          allProjectCount={allProjectCount}
          currentProjectAvailable={currentProjectAvailable}
        />
      </div>

      {/* Search bar row — with refresh button */}
      <div className="flex shrink-0 items-start gap-2">
        <div className="flex-1">
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
              className="mt-0.5 h-9 w-9 shrink-0"
              onClick={handleRebuildIndex}
              disabled={busy}
              data-testid="rebuild-index"
            >
              <PackageSearch className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <Trans>Refresh search data</Trans>
          </TooltipContent>
        </Tooltip>
      </div>

      <ActivityIndicator variant="strip" />

      {/* Stale banner — between search bar and calibration panel */}
      {indexState === 'stale' && statusState.phase === 'ready' && (
        <IndexRecommendedBanner
          lastIndexedAt={statusState.status.last_indexed_at!}
          types={statusState.status.default_types}
          onComplete={refreshStatus}
        />
      )}

      {/* Calibration panel */}
      {calibration.visible && (
        <SearchCalibrationPanel calibration={calibration} onChange={handleCalibrationChange} latencyMs={latencyMs} />
      )}

      {/* Results */}
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="search-results">
        {!indexerReady && (
          <div className="flex items-start gap-2 rounded-lg border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              <Trans>Search index is warming up. Results will appear once indexing is complete.</Trans>
            </span>
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

        {/* One empty state, branching on why it's empty. Never-indexed leads with an
            inline, non-blocking offer (the modal is opt-in — a first-run user is
            never interrupted by it); otherwise report the miss. */}
        {!isLoading && !error && results.length === 0 && (indexState === 'never_indexed' || hasActiveQuery) && (
          <div
            className="flex flex-col items-center gap-3 py-12 text-center text-muted-foreground"
            data-testid={indexState === 'never_indexed' ? 'search-never-indexed' : undefined}
          >
            <FileSearch className="h-10 w-10 opacity-40" />
            {indexState === 'never_indexed' ? (
              <>
                <div>
                  <p className="font-medium">{INDEX_PROMPT_TITLE}</p>
                  <p className="mx-auto max-w-md text-sm">{INDEX_PROMPT_DESCRIPTION}</p>
                </div>
                <Button onClick={() => setModalOpen(true)} data-testid="search-index-cta">
                  {INDEX_BUILD_LABEL}
                </Button>
              </>
            ) : (
              <div>
                <p className="font-medium">
                  <Trans>No records found</Trans>
                </p>
                {query.trim() ? (
                  <p className="text-sm">
                    <Trans>No records found for &ldquo;{query}&rdquo;</Trans>
                  </p>
                ) : (
                  <p className="text-sm">
                    <Trans>No records of this type</Trans>
                  </p>
                )}
              </div>
            )}
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
          onComplete={() => {
            setModalOpen(false);
            refreshStatus();
          }}
          onDeny={() => setModalOpen(false)}
        />
      )}
    </div>
  );
}

export default SearchView;
