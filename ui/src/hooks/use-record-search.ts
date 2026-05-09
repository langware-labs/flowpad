import { useEffect, useRef, useState } from 'react';
import apiClient from '@sdk/client';
import { RecordType } from '@sdk/resource_management/fs_records';

const SEARCH_PATH = '/graph/compute_node/@local/fs-records/search';
const DEFAULT_SEARCH_LIMIT = 20;

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
  asset_ref: string;
  message_count?: number;
  labels?: string[];
  session_id?: string;
}

export interface UseRecordSearchResult {
  results: SearchResult[];
  isLoading: boolean;
  error: string | null;
  indexerReady: boolean;
  latencyMs: number | null;
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
  debounceMs = 300,
): UseRecordSearchResult {
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [indexerReady, setIndexerReady] = useState(true);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);

  const { col_weights, recency_boost, recency_factor, overfetch, type_scores } = calibration;

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);

    const hasFilter = !!(filters.record_type || filters.status || filters.scope || filters.time_preset);
    if (!hasFilter && (!query.trim() || query.trim().length < 2)) {
      setResults([]);
      setIsLoading(false);
      return;
    }

    cancelledRef.current = false;
    timerRef.current = setTimeout(() => {
      const params = new URLSearchParams({ q: query, limit: String(DEFAULT_SEARCH_LIMIT) });
      if (filters.record_type) params.set('record_type', filters.record_type);
      if (filters.status) params.set('status', filters.status);
      if (filters.scope) params.set('scope', filters.scope);
      if (filters.include_system) params.set('include_system', 'true');
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
          if (cancelledRef.current) return;
          const d = data as { results?: SearchResult[]; indexer_ready?: boolean } | null;
          const raw = d?.results ?? [];
          setResults(applyTimeFilter(raw, filters));
          setIndexerReady(d?.indexer_ready ?? true);
          setLatencyMs(Date.now() - startTime);
          setIsLoading(false);
        })
        .catch((err: unknown) => {
          if (cancelledRef.current) return;
          setError(err instanceof Error ? err.message : 'Search failed');
          setIsLoading(false);
        });
    }, debounceMs);

    return () => {
      cancelledRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query, filters.record_type, filters.status, filters.scope, filters.time_preset, filters.time_start, filters.time_end, filters.include_system, col_weights, recency_boost, recency_factor, overfetch, type_scores, debounceMs]);

  return { results, isLoading, error, indexerReady, latencyMs };
}
