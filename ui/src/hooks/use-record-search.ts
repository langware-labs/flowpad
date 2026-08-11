import { useEffect, useRef, useState } from 'react';
import apiClient from '@sdk/client';
import { RecordType } from '@sdk/resource_management/fs_records';
import { applyScopeToParams, scopeFilterKey, type ScopeFilter } from '@src/lib/scope-filter';

const SEARCH_PATH = '/graph/compute_node/@local/fs-records/search';
const DEFAULT_SEARCH_LIMIT = 20;

/** Shortest query this hook will actually send. Exported so a caller can gate
 *  its own UI on the same threshold instead of guessing at it. */
export const MIN_SEARCH_QUERY_LENGTH = 2;

const ANNOTATION_LABEL_DISPLAY: Record<string, string> = {
  prompt: 'user prompt',
};

export function getSearchResultBadgeLabel(result: { record_type: string; labels?: string[] }): string {
  if (result.record_type === RecordType.ANNOTATION && result.labels?.length) {
    const key = result.labels[0].replace(/:$/, '');
    return ANNOTATION_LABEL_DISPLAY[key] ?? key;
  }
  return result.record_type.replace('claude_', '');
}

export interface SearchFilters {
  record_type?: string;
  status?: string;
  scope?: string;
  time_preset?: '1h' | '1d' | '1w' | 'custom';
  time_start?: string;  // ISO string (used when time_preset === 'custom')
  time_end?: string;    // ISO string (used when time_preset === 'custom')
  include_system?: boolean;  // Show SDK-shipped system-project entities. Default off.
  /** Browse without a text query, ordered by explicit user-edit activity. */
  sort_by?: 'last_edited_at';
}

export interface SearchCalibration {
  col_weights?: [number, number, number, number, number, number]; // [entity_id, type, name, title, description, content]
  recency_boost?: number;
  recency_factor?: number;  // Python-side blend: bm25 / (1 + days * k)
  overfetch?: number;       // extra rows fetched beyond limit for blend (additive)
  type_scores?: Record<string, number>;
  visible?: boolean;  // UI state — persisted but not sent to backend
}

export interface SearchResult {
  record_id: string;
  record_type: string;
  name: string;
  text: string;
  snippet?: string;
  fts_title?: string;
  fts_description?: string;
  status: string;
  scope: string;
  created_at: string;
  modified_at: string;
  /** Epoch milliseconds; present on explicit recent-activity browse rows. */
  last_edited_at?: number | string | null;
  asset_ref: string;
  message_count?: number;
  labels?: string[];
  session_id?: string;
}

export interface UseRecordSearchResult {
  results: SearchResult[];
  /** Matching rows before backend pagination. */
  total: number;
  isLoading: boolean;
  error: string | null;
  indexerReady: boolean;
  latencyMs: number | null;
}

export interface RecordSearchRequestOptions {
  /** Backend page size. Search keeps its established default when omitted. */
  limit?: number;
  /** Suppress the request while required scope context is unresolved. */
  enabled?: boolean;
}

const LS_CALIBRATION_KEY = 'flowpad-search-calibration';

export function loadStoredCalibration(): SearchCalibration {
  try { return JSON.parse(localStorage.getItem(LS_CALIBRATION_KEY) ?? 'null') ?? {}; }
  catch { return {}; }
}

export function saveCalibration(c: SearchCalibration) {
  try { localStorage.setItem(LS_CALIBRATION_KEY, JSON.stringify(c)); } catch {}
}

const TIME_OFFSETS: Record<string, number> = { '1h': 3_600_000, '1d': 86_400_000, '1w': 604_800_000 };

function applyTimeFilter(results: SearchResult[], filters: SearchFilters): SearchResult[] {
  const { time_preset, time_start, time_end } = filters;
  if (!time_preset) return results;
  if (time_preset !== 'custom') {
    const cutoff = new Date(Date.now() - TIME_OFFSETS[time_preset]);
    return results.filter(r => r.modified_at && new Date(r.modified_at) >= cutoff);
  }
  if (!time_start) return results;
  const start = new Date(time_start);
  const end = time_end ? new Date(time_end) : new Date();
  return results.filter(r => r.modified_at && new Date(r.modified_at) >= start && new Date(r.modified_at) <= end);
}

export function useRecordSearch(
  query: string,
  filters: SearchFilters = {},
  calibration: SearchCalibration = {},
  // Optional ScopeFilter (user + projects). Separate from `filters.scope`,
  // which is the legacy enum-style scope tag. When provided, the backend's
  // _handle_fs_records_search narrows the search by user / project entities.
  scopeFilter: ScopeFilter | null = null,
  debounceMs = 300,
  requestOptions: RecordSearchRequestOptions = {},
): UseRecordSearchResult {
  const [results, setResults] = useState<SearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [indexerReady, setIndexerReady] = useState(true);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { col_weights, recency_boost, recency_factor, overfetch, type_scores } = calibration;
  const { limit = DEFAULT_SEARCH_LIMIT, enabled = true } = requestOptions;

  useEffect(() => {
    let cancelled = false;
    if (timerRef.current) clearTimeout(timerRef.current);

    if (!enabled) {
      setResults([]);
      setTotal(0);
      setIsLoading(false);
      return;
    }

    // `filters.scope` is intentionally excluded — it no longer drives the
    // request (the canonical ScopeFilter does that). Gating on it here used
    // to fire searches that came back unscoped, which silently rendered
    // global results in scope-only UIs.
    const hasFilter = !!(filters.record_type || filters.status || filters.time_preset || filters.sort_by);
    if (!hasFilter && query.trim().length < MIN_SEARCH_QUERY_LENGTH) {
      setResults([]);
      setTotal(0);
      setIsLoading(false);
      return;
    }

    timerRef.current = setTimeout(() => {
      const params = new URLSearchParams({ q: query, limit: String(limit) });
      if (filters.record_type) params.set('record_type', filters.record_type);
      if (filters.status) params.set('status', filters.status);
      if (filters.include_system) params.set('include_system', 'true');
      if (filters.sort_by) params.set('sort_by', filters.sort_by);
      // Canonical scope wire-format — `user=…&projects=…`. The legacy
      // `filters.scope` enum string used to be sent as `?scope=<enum>` but
      // the backend never read it; the ScopeFilter below is the only path.
      if (scopeFilter) applyScopeToParams(params, scopeFilter);
      if (col_weights) params.set('col_weights', col_weights.join(','));
      if (recency_boost) params.set('recency_boost', String(recency_boost));
      if (recency_factor) params.set('recency_factor', String(recency_factor));
      if (overfetch) params.set('overfetch', String(overfetch));
      if (type_scores && Object.keys(type_scores).length)
        params.set('type_scores', JSON.stringify(type_scores));

      setIsLoading(true);
      setError(null);

      const startTime = Date.now();
      apiClient
        .get(`${SEARCH_PATH}?${params.toString()}`)
        .then((data: unknown) => {
          if (cancelled) return;
          const d = data as { results?: SearchResult[]; total?: number; indexer_ready?: boolean } | null;
          const raw = d?.results ?? [];
          setResults(applyTimeFilter(raw, filters));
          setTotal(d?.total ?? raw.length);
          setIndexerReady(d?.indexer_ready ?? true);
          setLatencyMs(Date.now() - startTime);
          setIsLoading(false);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : 'Search failed');
          setIsLoading(false);
        });
    }, debounceMs);

    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query, filters.record_type, filters.status, filters.time_preset, filters.time_start, filters.time_end, filters.include_system, filters.sort_by, scopeFilter ? scopeFilterKey(scopeFilter) : null, col_weights, recency_boost, recency_factor, overfetch, type_scores, debounceMs, enabled, limit]);

  return { results, total, isLoading, error, indexerReady, latencyMs };
}
