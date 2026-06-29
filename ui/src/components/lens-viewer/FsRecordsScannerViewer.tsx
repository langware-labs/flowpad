import apiClient from '@sdk/client';
import { dataContext } from '@sdk';
import { RecordSearchBar } from '@src/components/record-search-bar/RecordSearchBar';
import { SearchResultCard } from '@src/components/record-search-bar/SearchResultCard';
import { ActivityIndicator } from '@src/components/search-index/ActivityIndicator';
import { useIndexStatus } from '@src/hooks/use-index-status';
import { useSystemTools } from '@src/hooks/use-system-tools';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { RefreshCw, ChevronDown, ChevronRight, Search, Database, FileSearch, Trash2, ScanSearch, Ghost, RotateCw, ListTree } from 'lucide-react';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { SweepOrphansDialog } from '@src/components/search-index/SweepOrphansDialog';
import { EntitySearchModal } from '@src/components/search-index/EntitySearchModal';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@src/components/ui/alert-dialog';
import { SearchFilters, useRecordSearch } from '@src/hooks/use-record-search';
import { formatTimeAgo } from '@src/utils/format-time-ago';
import { ScopeFilterBar } from '@src/components/scope-filter/ScopeFilterBar';
import {
  applyScopeToParams,
  filterScope,
  scopeFilterEqual,
  scopeFilterKey,
  scopeIncludesUser,
  scopeProjectIds,
  userScope,
  type ScopeFilter,
} from '@src/lib/scope-filter';
import { useProjectList } from '@src/hooks/use-claude-projects';

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
  orphan_count: number;
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
  // Diff against the live index — present when scan ran un-scoped.
  new?: number;
  stale?: number;
  mis_scoped?: number;
  orphan?: number;
  fresh?: number;
  in_index?: number;
  pending?: number;
}

// Shape of POST /fs-records/index (aggregate). ``types[].new`` = entities
// actually (re)indexed this run (vs skipped-fresh).
interface AggregateIndexResult {
  types?: { type: string; new?: number; indexed?: number; skipped?: number }[];
}

interface AggregateScan {
  types: AggregateScanType[];
  grand_total: number;
  scan_ms: number;
  grand_pending?: number;
  grand_orphan?: number;
  diff_included?: boolean;
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
  onSweepOrphans,
  onViewIndexed,
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
  onSweepOrphans: (type: string) => void;
  onViewIndexed: (type: string) => void;
  indexing: boolean;
  clearing: boolean;
  indexedCount: number | null;
  active: boolean;
}) {
  const { t } = useLingui();
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
        <td
          className={`py-2 pr-4 text-right tabular-nums text-sm ${row.orphan_count > 0 ? 'text-amber-600 dark:text-amber-400 cursor-pointer hover:underline' : 'text-muted-foreground'}`}
          onClick={(e) => {
            e.stopPropagation();
            if (row.orphan_count > 0) onSweepOrphans(row.type);
          }}
          title={row.orphan_count > 0 ? `Click to sweep ${row.orphan_count} ${row.type} orphans` : 'No orphans for this type'}
        >
          {row.orphan_count > 0 ? row.orphan_count : '—'}
        </td>
        <td className="py-2 pr-4 text-right text-xs text-muted-foreground">
          {formatTimeAgo(row.last_indexed_at) ?? '—'}
        </td>
        <td className="py-2 pr-3 text-right text-xs text-muted-foreground">
          {indexedCount !== null ? (
            <button
              type="button"
              className="text-emerald-600 hover:underline dark:text-emerald-400"
              onClick={(e) => { e.stopPropagation(); onViewIndexed(row.type); }}
              title={`View the ${indexedCount} ${row.type} ${indexedCount === 1 ? 'entity' : 'entities'} indexed this run`}
            >
              <Trans>{indexedCount} indexed</Trans>
            </button>
          ) : row.error ? (
            <span className="text-destructive"><Trans>error</Trans></span>
          ) : row.orphan_count > 0 ? (
            <span className="text-amber-600 dark:text-amber-400"><Trans id="orphan_count">{row.orphan_count} orphan{row.orphan_count === 1 ? '' : 's'}</Trans></span>
          ) : row.stale && !(row.count === 0 && row.last_indexed_at === null) ? (
            <span
              className="text-amber-600 dark:text-amber-400"
              title={row.last_indexed_at === null ? t`Last indexed: never` : `Last indexed: ${row.last_indexed_at}`}
            >
              {row.last_indexed_at === null ? <Trans>never indexed</Trans> : <Trans>24h+ idle</Trans>}
            </span>
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
                  ? t`Indexed ${indexedCount} records`
                  : t`Sync ${row.type} changes`}
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
                  {t`Clear ${row.type} index`}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={7} className="bg-muted/30 px-4 py-2">
            {loadingDetail ? (
              <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
                <RefreshCw className="h-3 w-3 animate-spin" />
                <Trans>Loading records…</Trans>
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
  const { t } = useLingui();
  // Unified scope chip — same component, same shape, same wire format as the
  // assets page. Drives every action and every count on this page so the
  // user sees one consistent view of "what scope am I operating on".
  const { navigation } = useDockNavigation();
  const currentProjectId = dataContext.project?.id ?? null;
  // Default scope is "All" with every project selected. Project ids arrive
  // async (useProjectList), so seed user+current-project immediately and
  // widen to the full project set once the list loads — unless the user has
  // already touched the scope chips.
  const [scope, setScope] = useState<ScopeFilter>(() =>
    currentProjectId ? filterScope(true, [currentProjectId]) : userScope(),
  );
  const scopeTouched = useRef(false);
  const handleScopeChange = useCallback((next: ScopeFilter) => {
    scopeTouched.current = true;
    setScope(next);
  }, []);

  const { projects: projectList } = useProjectList();
  const allProjectIds = useMemo(() => {
    const ids = new Set<string>();
    for (const p of projectList) {
      const pid = p.id;
      if (pid) ids.add(pid);
    }
    return [...ids];
  }, [projectList]);

  useEffect(() => {
    if (scopeTouched.current || allProjectIds.length === 0) return;
    setScope((prev) =>
      scopeFilterEqual(prev, filterScope(true, allProjectIds))
        ? prev
        : filterScope(true, allProjectIds),
    );
  }, [allProjectIds]);

  // Derive scope facts once — `scopeProjectIds`/`scopeIncludesUser` are
  // recomputed below (footer label, selection check) and each rebuilds an array.
  const selectedProjectIds = scopeProjectIds(scope);
  const scopeHasUser = scopeIncludesUser(scope);
  const selectedProjectIdSet = new Set(selectedProjectIds);
  const allProjectsSelected =
    allProjectIds.length > 0 && allProjectIds.every((id) => selectedProjectIdSet.has(id));
  const scopeIsDefault = allProjectIds.length === 0
    ? scopeHasUser
    : scopeFilterEqual(scope, filterScope(true, allProjectIds));
  const scopeQs = useCallback((): string => {
    const p = new URLSearchParams();
    applyScopeToParams(p, scope);
    return p.toString();
  }, [scope]);

  const { state: indexStatus, refresh: refreshIndexStatus } = useIndexStatus(scope);
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
      orphan_count: pt.orphan_count,
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

  // Drop the per-type expand cache when the scope chip changes — the
  // narrowed result set means the cached size/record list is misleading.
  // useIndexStatus(scope) handles its own re-fetch via the scopeKey dep.
  const lastScopeKey = useRef(scopeFilterKey(scope));
  useEffect(() => {
    const k = scopeFilterKey(scope);
    if (k !== lastScopeKey.current) {
      lastScopeKey.current = k;
      setDetails({});
      setExpandedType(null);
    }
  }, [scope]);

  // F4/F5 — Scan Orphans dialog (toolbar + per-row click both open this).
  const [sweepOpen, setSweepOpen] = useState(false);
  const [sweepScopeType, setSweepScopeType] = useState<string | null>(null);
  const openSweepDialog = useCallback((scope: string | null) => {
    setSweepScopeType(scope);
    setSweepOpen(true);
  }, []);

  // Detail cache keyed by type. Loaded on row expand — /fs-records/scan?type=X
  // gives the size breakdown + per-record list, on demand.
  const [details, setDetails] = useState<Record<string, TypeDetail>>({});
  const [loadingDetail, setLoadingDetail] = useState<string | null>(null);
  const [expandedType, setExpandedType] = useState<string | null>(null);

  // Per-type re-index UI state (the row-hover Database button).
  const [indexingTypes, setIndexingTypes] = useState<Set<string>>(new Set());
  const [clearingTypes, setClearingTypes] = useState<Set<string>>(new Set());
  const [indexedResults, setIndexedResults] = useState<Record<string, number>>({});
  // Type whose "N indexed" cell was clicked → opens the generic entity table.
  const [viewIndexedType, setViewIndexedType] = useState<string | null>(null);

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

  // Record per-type "actually indexed this run" counts from an aggregate
  // index response, so each row's status cell can show a clickable "N indexed".
  const captureIndexed = useCallback((res: AggregateIndexResult | null | undefined) => {
    const types = res?.types;
    if (!types?.length) return;
    setIndexedResults((prev) => {
      const next = { ...prev };
      for (const t of types) next[t.type] = t.new ?? 0;
      return next;
    });
  }, []);

  const handleRefreshIndex = useCallback(async () => {
    // One aggregate call. Backend's FSIndexer.index() walks default_roots()
    // and emits progress_report events (scan phase then index phase) that the
    // footer pill, this page's progress bar, and any other listener all see
    // from the same stream.
    try {
      const res = await apiClient.post<AggregateIndexResult>(`${BASE}/index?${scopeQs()}`);
      captureIndexed(res);
    } finally {
      // index-status auto-refreshes on activity→idle via the effect above;
      // detail cache is invalidated so the next expand re-fetches.
      setDetails({});
    }
  }, [scopeQs, captureIndexed]);

  // Force re-sync: same walk, but bypass skip-fresh — re-parse and re-upsert
  // EVERY entry under the default roots. DB ids preserved (no clear). Useful
  // when a parser bug or schema change means stored content is wrong even
  // though mtime hasn't moved.
  const [forceResyncing, setForceResyncing] = useState(false);
  const handleForceResync = useCallback(async () => {
    setForceResyncing(true);
    try {
      const res = await apiClient.post<AggregateIndexResult>(`${BASE}/index?force=true&${scopeQs()}`);
      captureIndexed(res);
    } finally {
      setForceResyncing(false);
      setDetails({});
    }
  }, [scopeQs, captureIndexed]);

  const handleClearIndex = useCallback(async () => {
    // Scoped DELETE — bypasses the legacy clearIndex() hook helper because
    // that one always wipes the full type set. Backend honors ?user=&projects=.
    try {
      await apiClient.delete(`${BASE}/index?${scopeQs()}`);
    } catch {
      // ignore — fall back to legacy unscoped clear via the hook
      await clearIndex();
    }
    setIndexedResults({});
    setDetails({});
    refreshIndexStatus();
  }, [clearIndex, refreshIndexStatus, scopeQs]);

  const handleClearType = useCallback(
    async (typeName: string) => {
      setClearingTypes((prev) => new Set(prev).add(typeName));
      try {
        await apiClient.delete(
          `${BASE}/index?type=${encodeURIComponent(typeName)}&${scopeQs()}`,
        );
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
    [refreshIndexStatus, scopeQs],
  );

  const handleScanStats = useCallback(async () => {
    setScanStatsLoading(true);
    setScanStatsOpen(true);
    try {
      const r = await apiClient.get<AggregateScan>(`${BASE}/scan?${scopeQs()}`);
      setScanStats(r as unknown as AggregateScan);
    } catch {
      setScanStats(null);
    } finally {
      setScanStatsLoading(false);
    }
  }, [scopeQs]);

  // Re-index a single type from inside the Scan Stats modal, then refresh both
  // the modal's stats and the page's per-type rows. Visible "indexing…" state
  // is driven by `indexingTypes` (same as the row-hover indexer), so the
  // modal's row spinner mirrors the page's hover spinner.
  const handleRefreshTypeFromStats = useCallback(
    async (typeName: string) => {
      setIndexingTypes((prev) => new Set(prev).add(typeName));
      try {
        await indexTypeFromHook(typeName, scope);
        // Reload aggregate scan so FS Count / DB Count / Diff reflect the new
        // post-index state.
        try {
          const r = await apiClient.get<AggregateScan>(`${BASE}/scan?${scopeQs()}`);
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
    [indexTypeFromHook, refreshIndexStatus, scope, scopeQs],
  );

  const handleIndexType = useCallback(
    async (typeName: string) => {
      setIndexingTypes((prev) => new Set(prev).add(typeName));
      try {
        const res = await indexTypeFromHook(typeName, scope);
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
    [indexTypeFromHook, scope],
  );

  const grandTotal = useMemo(() => typeRows.reduce((s, r) => s + r.count, 0), [typeRows]);
  const totalOrphans = indexStatus.phase === 'ready' ? indexStatus.status.total_orphans : 0;

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
  const currentActiveType = currentActivity ? (progressTable?.current ?? null) : null;
  const scanStatsProgress =
    scanStatsLoading && currentActivity === 'scan' && progressTable?.job_name === 'scan'
      ? progressTable
      : null;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header — toolbar (left → right):
            Fast           (Database)    — POST /fs-records/index           (delta by hash; default)
            Full           (RotateCw)    — POST /fs-records/index?force=true (complete rescan)
            Scan Stats     (ScanSearch)  — GET  /fs-records/scan            (read-only)
            Scan Orphans   (Ghost)       — open sweep dialog
            Clear Index    (Trash2)      — DELETE /fs-records/index         (wipe, no walk)
          Per-type Sync and Clear live as hover actions on each row. */}
      <div className="flex shrink-0 items-center justify-between border-b px-5 py-3">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-semibold"><Trans>Records Scanner</Trans></h1>
          <ScopeFilterBar
            scope={scope}
            currentProjectId={currentProjectId}
            onScopeChange={handleScopeChange}
          />
          <button
            type="button"
            onClick={() => handleScopeChange(filterScope(scopeIncludesUser(scope), allProjectIds))}
            disabled={allProjectIds.length === 0}
            aria-pressed={allProjectsSelected}
            title={allProjectsSelected ? t`Every project is selected` : t`Select every project`}
            data-testid="scope-all-projects"
            className={`flex h-7 items-center gap-1 rounded-md px-2.5 text-xs font-medium transition-colors ${
              allProjectsSelected
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
            } disabled:cursor-not-allowed disabled:opacity-50`}
          >
            <Trans>All projects</Trans>
            {allProjectIds.length > 0 && (
              <span
                className={`inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] ${
                  allProjectsSelected ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
                }`}
              >
                {allProjectIds.length}
              </span>
            )}
          </button>
        </div>
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={() => void handleRefreshIndex()}
                disabled={refreshing || clearing || forceResyncing}
                data-testid="toolbar-fast-index"
              >
                <Database className={`h-3.5 w-3.5 ${refreshing ? 'animate-pulse' : ''}`} />
                {refreshing ? <Trans>Indexing…</Trans> : <Trans>Fast</Trans>}
              </Button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              <p className="font-medium"><Trans>Fast — delta by hash</Trans></p>
              <p className="mt-1 text-xs opacity-90">
                <Trans>Walks the filesystem and re-indexes only entries whose source changed since last index (each record's <code>.hash</code> sentinel). Changes-pending drops to 0.</Trans>
              </p>
              <p className="mt-1 text-xs opacity-70"><Trans>The default — what you want 99% of the time.</Trans></p>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={() => void handleForceResync()}
                disabled={refreshing || clearing || forceResyncing}
                data-testid="toolbar-full-index"
              >
                <RotateCw className={`h-3.5 w-3.5 ${forceResyncing ? 'animate-spin' : ''}`} />
                {forceResyncing ? <Trans>Rebuilding…</Trans> : <Trans>Full</Trans>}
              </Button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              <p className="font-medium"><Trans>Full — complete rescan</Trans></p>
              <p className="mt-1 text-xs opacity-90">
                <Trans>Re-parses <em>every</em> entry, ignoring the <code>.hash</code> sentinel. Use after a parser or schema change, when stored content is wrong even though the source hasn't moved.</Trans>
              </p>
              <p className="mt-1 text-xs opacity-70"><Trans>Slower. To wipe rows first, use Clear Index then Full.</Trans></p>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={() => void handleScanStats()}
                disabled={scanStatsLoading || refreshing || clearing || forceResyncing}
              >
                <ScanSearch className={`h-3.5 w-3.5 ${scanStatsLoading ? 'animate-pulse' : ''}`} />
                {scanStatsLoading ? <Trans>Scanning…</Trans> : <Trans>Scan Stats</Trans>}
              </Button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              <p className="font-medium"><Trans>Scan Stats</Trans></p>
              <p className="mt-1 text-xs opacity-90">
                <Trans>Walks the filesystem and reports per-type counts and sizes (and, soon, the diff against the index). Read-only — no DB writes, no <code>last_indexed_at</code> bump.</Trans>
              </p>
              <p className="mt-1 text-xs opacity-70"><Trans>~2s. Use to check what's on disk without changing anything.</Trans></p>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className={`h-7 gap-1.5 text-xs ${totalOrphans > 0 ? 'text-amber-600 hover:text-amber-700 dark:text-amber-400' : ''}`}
                onClick={() => openSweepDialog(null)}
                disabled={refreshing || clearing || forceResyncing}
                data-testid="toolbar-scan-orphans"
              >
                <Ghost className="h-3.5 w-3.5" />
                <Trans>Scan Orphans</Trans>
                {totalOrphans > 0 && (
                  <span className="ml-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                    {totalOrphans}
                  </span>
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              <p className="font-medium"><Trans>Scan Orphans</Trans></p>
              <p className="mt-1 text-xs opacity-90">
                <Trans>An orphan is a DB row (or shadow record dir) whose source file is gone from disk. The sweep dialog lets you remove just the DB row (IGNORE, keeps a forensic shadow dir) or both row + shadow (DELETE).</Trans>
              </p>
              <p className="mt-1 text-xs opacity-70">
                {totalOrphans > 0
                  ? t`${totalOrphans} orphan record${totalOrphans === 1 ? '' : 's'} pending review.`
                  : t`No orphans right now. Click to re-scan and confirm.`}
              </p>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={() => navigation.openDock(DockPointer.forLlmIndexers())}
                data-testid="toolbar-llm-indexers"
              >
                <ListTree className="h-3.5 w-3.5" />
                <Trans>LLM Indexers</Trans>
              </Button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              <p className="font-medium"><Trans>LLM Indexers</Trans></p>
              <p className="mt-1 text-xs opacity-90">
                <Trans>Browse and run LLM-generated folder indexes (MarkdownIndex entities). Each indexer (re)builds a Merkle tree of <code>index.md</code> files over a docs root.</Trans>
              </p>
              <p className="mt-1 text-xs opacity-70"><Trans>Runs as an AgenticProcess — see per-row status + transcript.</Trans></p>
            </TooltipContent>
          </Tooltip>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 text-xs text-destructive hover:text-destructive"
                disabled={clearing || refreshing || forceResyncing}
              >
                <Trash2 className={`h-3.5 w-3.5 ${clearing ? 'animate-pulse' : ''}`} />
                {clearing ? <Trans>Clearing…</Trans> : <Trans>Clear Index</Trans>}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle><Trans>Clear search index?</Trans></AlertDialogTitle>
                <AlertDialogDescription>
                  <Trans>Wipes the DB rows + FTS entries for every indexable type. The index becomes empty until you re-populate it. Files on disk are <em>not</em> touched. After clearing, click <strong>Fast</strong> to re-index changed entries, or <strong>Full</strong> to re-index everything.</Trans>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel><Trans>Cancel</Trans></AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={() => void handleClearIndex()}
                >
                  <Trans>Clear Index</Trans>
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {/* While any index activity (scan / index / clear) is running, the body is
          ONLY the live per-type progress. The search bar, totals, filter, and
          type table would otherwise pile up alongside it into an unreadable mix —
          they all return the moment the run goes idle (currentActivity → null). */}
      {currentActivity ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-3">
          {/* Global progress bar on top — count-only while scanning (totals
              unknown), filling to a percentage once the index loop starts. */}
          <ActivityIndicator variant="bar" />
          <ActivityIndicator variant="list" className="flex flex-col gap-1.5" />
        </div>
      ) : (
      <>
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
          <span className="font-medium"><Trans id="records_count">{grandTotal.toLocaleString()} records</Trans></span>
          {' · '}
          <span className="text-muted-foreground"><Trans id="types_count">{typeRows.length} types</Trans></span>
          {lastIndexedLabel && (
            <>
              {' · '}
              <span className="text-muted-foreground"><Trans id="last_indexed_at">last indexed {lastIndexedLabel}</Trans></span>
            </>
          )}
          {totalOrphans > 0 && (
            <>
              {' · '}
              <button
                type="button"
                onClick={() => openSweepDialog(null)}
                className="text-amber-600 hover:underline dark:text-amber-400"
              >
                <Trans id="orphans_count">{totalOrphans} orphan{totalOrphans === 1 ? '' : 's'}</Trans>
              </button>
            </>
          )}
          {!scopeIsDefault && (
            <>
              {' · '}
              <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
                {scopeHasUser && selectedProjectIds.length > 0
                  ? t`scope: user + ${selectedProjectIds.length} project${selectedProjectIds.length === 1 ? '' : 's'}`
                  : scopeHasUser
                    ? t`scope: user only`
                    : t`scope: ${selectedProjectIds.length} project${selectedProjectIds.length === 1 ? '' : 's'} only`}
              </span>
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
              <span><Trans>Search index is warming up. Run Refresh Index to populate it.</Trans></span>
            </div>
          )}
          {searchLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <RefreshCw className="h-4 w-4 animate-spin" />
              <Trans>Searching…</Trans>
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
                <p className="font-medium"><Trans>No records found</Trans></p>
                <p className="text-sm"><Trans id="no_results_for">No results for "{searchQuery}"</Trans></p>
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
                  placeholder={t`Filter types…`}
                  className="h-7 pl-8 text-xs"
                />
              </div>
              <Button
                variant={showNonEmpty ? 'secondary' : 'ghost'}
                size="sm"
                className="h-7 text-xs"
                onClick={() => setShowNonEmpty((v) => !v)}
              >
                <Trans>Non-empty</Trans>
              </Button>
            </div>
          )}

          {/* Type table */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {indexStatus.phase !== 'ready' && (
              <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                <RefreshCw className="h-3.5 w-3.5 animate-spin" /> <Trans>Loading index status…</Trans>
              </div>
            )}
            {indexStatus.phase === 'ready' && typeRows.length === 0 && (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted-foreground">
                <p className="text-sm">
                  <Trans>Nothing indexed yet. <button
                    className="font-medium text-foreground underline-offset-2 hover:underline"
                    onClick={() => void handleRefreshIndex()}
                    disabled={refreshing}
                  >
                    Refresh Index
                  </button> to populate.</Trans>
                </p>
              </div>
            )}
            {filteredRows.length > 0 && (
              <table className="w-full">
                <thead className="sticky top-0 z-10 border-b bg-card text-xs text-muted-foreground">
                  <tr>
                    <th className="w-6 py-2 pl-3 pr-2" />
                    <th className="py-2 pr-4 text-left font-medium"><Trans>Type</Trans></th>
                    <th className="py-2 pr-4 text-right font-medium"><Trans>Records</Trans></th>
                    <th className="py-2 pr-4 text-right font-medium" title={t`DB rows whose source file is gone. Click a non-zero count to sweep.`}>
                      <Trans>Orphans</Trans>
                    </th>
                    <th className="py-2 pr-4 text-right font-medium"><Trans>Last Indexed</Trans></th>
                    <th className="py-2 pr-3 text-right font-medium"><Trans>Status</Trans></th>
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
                      onSweepOrphans={openSweepDialog}
                      onViewIndexed={setViewIndexedType}
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
                <Trans>No types match filter</Trans>
              </div>
            )}
          </div>
        </>
      )}
      </>
      )}

      {/* Sweep Orphans dialog — explainer + per-type breakdown + sweep action.
          Driven by the toolbar Scan Orphans button OR a row-cell click on a
          non-zero Orphans count (scopeType set in that case). */}
      <SweepOrphansDialog
        open={sweepOpen}
        onOpenChange={setSweepOpen}
        scopeType={sweepScopeType}
        perType={indexStatus.phase === 'ready' ? (indexStatus.status.per_type ?? []) : []}
        totalOrphans={totalOrphans}
        scope={scope}
      />

      {/* Generic entity table — opened from a row's "N indexed" cell. Shows the
          type's entities recency-first (just-indexed at the top), backed by the
          generic search endpoint. No scope filter: a type's just-indexed set can
          span scopes (e.g. claude_session is project-scoped even under a user
          walk), so scoping by the chip would hide the very rows we want. */}
      <EntitySearchModal
        open={viewIndexedType !== null}
        onOpenChange={(o) => { if (!o) setViewIndexedType(null); }}
        title={viewIndexedType ? `Recently indexed · ${viewIndexedType}` : 'Recently indexed'}
        recordType={viewIndexedType ?? undefined}
      />

      {/* Scan Stats modal — one-shot aggregate scan report. */}
      <Dialog open={scanStatsOpen} onOpenChange={setScanStatsOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle><Trans>Scan Stats</Trans></DialogTitle>
            <DialogDescription>
              <Trans>Walked the filesystem without writing. Counts and sizes reflect what is on disk right now; compare against the per-type rows to see drift.</Trans>
            </DialogDescription>
          </DialogHeader>
          {scanStatsLoading ? (
            <div className="flex items-center gap-3 py-6 text-sm">
              <RefreshCw className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-foreground"><Trans>Scanning filesystem…</Trans></span>
                <span className="text-xs text-muted-foreground">
                  {scanStatsProgress
                    ? `${scanStatsProgress.done.toLocaleString()} found so far${
                        scanStatsProgress.current ? ` · ${scanStatsProgress.current}` : ''
                      }`
                    : <Trans>Starting scan…</Trans>}
                </span>
              </div>
            </div>
          ) : scanStats ? (
            <div className="flex flex-col gap-2">
              <div className="text-sm">
                <span className="font-medium"><Trans id="records_on_disk">{scanStats.grand_total.toLocaleString()} records on disk</Trans></span>
                {' · '}
                <span className="text-muted-foreground"><Trans id="types_time">{scanStats.types.length} types · {fmtMs(scanStats.scan_ms)}</Trans></span>
                {scanStats.diff_included && (
                  <>
                    {' · '}
                    <span className={(scanStats.grand_pending ?? 0) > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}>
                      <Trans id="pending_count">Pending: {(scanStats.grand_pending ?? 0).toLocaleString()}</Trans>
                    </span>
                    {' · '}
                    <span className={(scanStats.grand_orphan ?? 0) > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}>
                      <Trans id="orphans_total">Orphans: {(scanStats.grand_orphan ?? 0).toLocaleString()}</Trans>
                    </span>
                  </>
                )}
              </div>
              <div className="max-h-[55vh] overflow-y-auto rounded border bg-card">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b bg-muted/50 text-muted-foreground">
                      <th className="py-1 pl-3 pr-3 text-left font-medium"><Trans>Type</Trans></th>
                      <th className="py-1 pr-3 text-right font-medium"><Trans>On Disk</Trans></th>
                      <th className="py-1 pr-3 text-right font-medium"><Trans>In Index</Trans></th>
                      <th className="py-1 pr-3 text-right font-medium" title={t`Files on disk not yet in the DB`}><Trans>New</Trans></th>
                      <th className="py-1 pr-3 text-right font-medium" title={t`File mtime is newer than DB updated_date`}><Trans>Stale</Trans></th>
                      <th className="py-1 pr-3 text-right font-medium" title={t`DB row's scope/project_id no longer matches walk`}><Trans>Mis-Sc</Trans></th>
                      <th className="py-1 pr-3 text-right font-medium" title={t`DB row or shadow dir, file is gone`}><Trans>Orphan</Trans></th>
                      <th className="py-1 pr-3 text-right font-medium"><Trans>Size</Trans></th>
                      <th className="w-10 py-1 pr-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {scanStats.types
                      .filter((t) => (t.count ?? 0) > 0 || (t.in_index ?? 0) > 0 || (t.orphan ?? 0) > 0)
                      .sort((a, b) => (b.count + (b.orphan ?? 0)) - (a.count + (a.orphan ?? 0)))
                      .map((t) => {
                        const isIndexing = indexingTypes.has(t.type);
                        const amber = 'text-amber-600 dark:text-amber-400';
                        const dim = 'text-muted-foreground';
                        const newN = t.new ?? 0;
                        const staleN = t.stale ?? 0;
                        const miscN = t.mis_scoped ?? 0;
                        const orphN = t.orphan ?? 0;
                        const inIdx = t.in_index ?? 0;
                        return (
                          <tr key={t.type} className="group border-b last:border-0">
                            <td className="py-1 pl-3 pr-3 font-mono">{t.type}</td>
                            <td className="py-1 pr-3 text-right tabular-nums">{t.count}</td>
                            <td className={`py-1 pr-3 text-right tabular-nums ${dim}`}>{inIdx}</td>
                            <td className={`py-1 pr-3 text-right tabular-nums ${newN > 0 ? amber : dim}`}>{newN || '—'}</td>
                            <td className={`py-1 pr-3 text-right tabular-nums ${staleN > 0 ? amber : dim}`}>{staleN || '—'}</td>
                            <td className={`py-1 pr-3 text-right tabular-nums ${miscN > 0 ? amber : dim}`}>{miscN || '—'}</td>
                            <td className={`py-1 pr-3 text-right tabular-nums ${orphN > 0 ? amber : dim}`}>{orphN || '—'}</td>
                            <td className={`py-1 pr-3 text-right tabular-nums ${dim}`}>{fmtBytes(t.total_bytes)}</td>
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
                                  {isIndexing ? t`Syncing ${t.type}…` : t`Sync ${t.type} changes and refresh stats`}
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
                <Trans><span className="text-amber-600 dark:text-amber-400">New / Stale / Mis-Sc</span> sum to <strong>Pending</strong>: a Fast index drives them all to 0. <span className="text-amber-600 dark:text-amber-400">Orphan</span> rows persist until you Scan Orphans → sweep.</Trans>
              </p>
            </div>
          ) : (
            <div className="py-6 text-sm text-destructive"><Trans>Scan failed.</Trans></div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
