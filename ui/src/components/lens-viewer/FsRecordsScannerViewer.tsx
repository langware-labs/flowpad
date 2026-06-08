import apiClient from '@sdk/client';
import { dataContext } from '@sdk';
import { RecordSearchBar } from '@src/components/record-search-bar/RecordSearchBar';
import { SearchResultCard } from '@src/components/record-search-bar/SearchResultCard';
import { ActivityIndicator } from '@src/components/search-index/ActivityIndicator';
import { useIndexStatus } from '@src/hooks/use-index-status';
import { useSystemTools } from '@src/hooks/use-system-tools';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { applyScopeToParams, scopeFilterEqual, scopeFilterKey, type ScopeFilter } from '@src/lib/scope-filter';
import { projectIdForPath } from '@src/components/assets/utils';
import { useClaudeProjectList } from '@src/hooks/use-claude-projects';

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
              {indexedCount} indexed
            </button>
          ) : row.error ? (
            <span className="text-destructive">error</span>
          ) : row.orphan_count > 0 ? (
            <span className="text-amber-600 dark:text-amber-400">{row.orphan_count} orphan{row.orphan_count === 1 ? '' : 's'}</span>
          ) : row.stale && !(row.count === 0 && row.last_indexed_at === null) ? (
            <span
              className="text-amber-600 dark:text-amber-400"
              title={row.last_indexed_at === null ? 'Last indexed: never' : `Last indexed: ${row.last_indexed_at}`}
            >
              {row.last_indexed_at === null ? 'never indexed' : '24h+ idle'}
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
                  ? `Indexed ${indexedCount} records`
                  : `Sync ${row.type} changes`}
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
          <td colSpan={7} className="bg-muted/30 px-4 py-2">
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
  // Unified scope chip — same component, same shape, same wire format as the
  // assets page. Drives every action and every count on this page so the
  // user sees one consistent view of "what scope am I operating on".
  const { navigation } = useDockNavigation();
  const currentProjectId = projectIdForPath(dataContext.project?.fs_storage_mount_path);
  // Default scope is "All" with every project selected. Project ids arrive
  // async (useClaudeProjectList), so seed user+current-project immediately and
  // widen to the full project set once the list loads — unless the user has
  // already touched the scope chips.
  const [scope, setScope] = useState<ScopeFilter>(() => ({
    user: true,
    projects: currentProjectId ? [currentProjectId] : [],
  }));
  const scopeTouched = useRef(false);
  const handleScopeChange = useCallback((next: ScopeFilter) => {
    scopeTouched.current = true;
    setScope(next);
  }, []);

  const { projects: projectList } = useClaudeProjectList();
  const allProjectIds = useMemo(() => {
    const ids = new Set<string>();
    for (const p of projectList) {
      const pid = projectIdForPath(p.cwd || p.name);
      if (pid) ids.add(pid);
    }
    return [...ids];
  }, [projectList]);

  useEffect(() => {
    if (scopeTouched.current || allProjectIds.length === 0) return;
    setScope((prev) =>
      scopeFilterEqual(prev, { user: true, projects: allProjectIds })
        ? prev
        : { user: true, projects: allProjectIds },
    );
  }, [allProjectIds]);

  const allProjectsSelected =
    allProjectIds.length > 0 && allProjectIds.every((id) => scope.projects.includes(id));
  const scopeIsDefault = allProjectIds.length === 0
    ? scope.user
    : scopeFilterEqual(scope, { user: true, projects: allProjectIds });
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
          <h1 className="text-sm font-semibold">Records Scanner</h1>
          <ScopeFilterBar
            scope={scope}
            currentProjectId={currentProjectId}
            onScopeChange={handleScopeChange}
          />
          <button
            type="button"
            onClick={() => handleScopeChange({ user: scope.user, projects: allProjectIds })}
            disabled={allProjectIds.length === 0}
            aria-pressed={allProjectsSelected}
            title={allProjectsSelected ? 'Every project is selected' : 'Select every project'}
            data-testid="scope-all-projects"
            className={`flex h-7 items-center gap-1 rounded-md px-2.5 text-xs font-medium transition-colors ${
              allProjectsSelected
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
            } disabled:cursor-not-allowed disabled:opacity-50`}
          >
            All projects
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
                {refreshing ? 'Indexing…' : 'Fast'}
              </Button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              <p className="font-medium">Fast — delta by hash</p>
              <p className="mt-1 text-xs opacity-90">
                Walks the filesystem and re-indexes only entries whose source changed since last index
                (each record's <code>.hash</code> sentinel). Changes-pending drops to 0.
              </p>
              <p className="mt-1 text-xs opacity-70">The default — what you want 99% of the time.</p>
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
                {forceResyncing ? 'Rebuilding…' : 'Full'}
              </Button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              <p className="font-medium">Full — complete rescan</p>
              <p className="mt-1 text-xs opacity-90">
                Re-parses <em>every</em> entry, ignoring the <code>.hash</code> sentinel. Use after a parser
                or schema change, when stored content is wrong even though the source hasn't moved.
              </p>
              <p className="mt-1 text-xs opacity-70">Slower. To wipe rows first, use Clear Index then Full.</p>
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
                {scanStatsLoading ? 'Scanning…' : 'Scan Stats'}
              </Button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              <p className="font-medium">Scan Stats</p>
              <p className="mt-1 text-xs opacity-90">
                Walks the filesystem and reports per-type counts and sizes (and, soon, the diff against the index).
                Read-only — no DB writes, no <code>last_indexed_at</code> bump.
              </p>
              <p className="mt-1 text-xs opacity-70">~2s. Use to check what's on disk without changing anything.</p>
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
                Scan Orphans
                {totalOrphans > 0 && (
                  <span className="ml-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                    {totalOrphans}
                  </span>
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              <p className="font-medium">Scan Orphans</p>
              <p className="mt-1 text-xs opacity-90">
                An orphan is a DB row (or shadow record dir) whose source file is gone from disk.
                The sweep dialog lets you remove just the DB row (IGNORE, keeps a forensic shadow dir) or both row + shadow (DELETE).
              </p>
              <p className="mt-1 text-xs opacity-70">
                {totalOrphans > 0
                  ? `${totalOrphans} orphan record${totalOrphans === 1 ? '' : 's'} pending review.`
                  : 'No orphans right now. Click to re-scan and confirm.'}
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
                LLM Indexers
              </Button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              <p className="font-medium">LLM Indexers</p>
              <p className="mt-1 text-xs opacity-90">
                Browse and run LLM-generated folder indexes (MarkdownIndex entities).
                Each indexer (re)builds a Merkle tree of <code>index.md</code> files over a docs root.
              </p>
              <p className="mt-1 text-xs opacity-70">Runs as an AgenticProcess — see per-row status + transcript.</p>
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
                {clearing ? 'Clearing…' : 'Clear Index'}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Clear search index?</AlertDialogTitle>
                <AlertDialogDescription>
                  Wipes the DB rows + FTS entries for every indexable type. The index becomes empty until you re-populate it.
                  Files on disk are <em>not</em> touched.
                  <br /><br />
                  After clearing, click <strong>Fast</strong> to re-index changed entries, or <strong>Full</strong> to re-index everything.
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

      <ActivityIndicator variant="list" className="shrink-0 border-b px-5 py-2 flex flex-col gap-1 max-h-44 overflow-auto" />


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
          {totalOrphans > 0 && (
            <>
              {' · '}
              <button
                type="button"
                onClick={() => openSweepDialog(null)}
                className="text-amber-600 hover:underline dark:text-amber-400"
              >
                {totalOrphans} orphan{totalOrphans === 1 ? '' : 's'}
              </button>
            </>
          )}
          {!scopeIsDefault && (
            <>
              {' · '}
              <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
                {scope.user && scope.projects.length > 0
                  ? `scope: user + ${scope.projects.length} project${scope.projects.length === 1 ? '' : 's'}`
                  : scope.user
                    ? 'scope: user only'
                    : `scope: ${scope.projects.length} project${scope.projects.length === 1 ? '' : 's'} only`}
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
                    <th className="py-2 pr-4 text-right font-medium">Records</th>
                    <th className="py-2 pr-4 text-right font-medium" title="DB rows whose source file is gone. Click a non-zero count to sweep.">
                      Orphans
                    </th>
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
                No types match filter
              </div>
            )}
          </div>
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
                {scanStats.diff_included && (
                  <>
                    {' · '}
                    <span className={(scanStats.grand_pending ?? 0) > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}>
                      Pending: {(scanStats.grand_pending ?? 0).toLocaleString()}
                    </span>
                    {' · '}
                    <span className={(scanStats.grand_orphan ?? 0) > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}>
                      Orphans: {(scanStats.grand_orphan ?? 0).toLocaleString()}
                    </span>
                  </>
                )}
              </div>
              <div className="max-h-[55vh] overflow-y-auto rounded border bg-card">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b bg-muted/50 text-muted-foreground">
                      <th className="py-1 pl-3 pr-3 text-left font-medium">Type</th>
                      <th className="py-1 pr-3 text-right font-medium">On Disk</th>
                      <th className="py-1 pr-3 text-right font-medium">In Index</th>
                      <th className="py-1 pr-3 text-right font-medium" title="Files on disk not yet in the DB">New</th>
                      <th className="py-1 pr-3 text-right font-medium" title="File mtime is newer than DB updated_date">Stale</th>
                      <th className="py-1 pr-3 text-right font-medium" title="DB row's scope/project_id no longer matches walk">Mis-Sc</th>
                      <th className="py-1 pr-3 text-right font-medium" title="DB row or shadow dir, file is gone">Orphan</th>
                      <th className="py-1 pr-3 text-right font-medium">Size</th>
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
                                  {isIndexing ? `Syncing ${t.type}…` : `Sync ${t.type} changes and refresh stats`}
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
                <span className="text-amber-600 dark:text-amber-400">New / Stale / Mis-Sc</span> sum to{' '}
                <strong>Pending</strong>: a Fast index drives them all to 0.{' '}
                <span className="text-amber-600 dark:text-amber-400">Orphan</span> rows persist until you Scan Orphans → sweep.
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
