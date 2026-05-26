import { useEffect, useRef, useState } from 'react';
import apiClient from '@sdk/client';
import type { SearchResult } from '@src/hooks/use-record-search';
import { applyScopeToParams, scopeFilterKey, type ScopeFilter } from '@src/lib/scope-filter';

const SEARCH_PATH = '/graph/compute_node/@local/fs-records/search';
const PER_TYPE_LIMIT = 25;
const DEFAULT_DEBOUNCE_MS = 250;

export interface UseMultiTypeSearchResult {
  results: SearchResult[];
  isLoading: boolean;
}

/**
 * Issues parallel /fs-records/search calls — one per record_type — and merges
 * results sorted by modified_at desc. Used when the active profile permits
 * multiple entity types simultaneously (e.g. terminal profile, no single type pinned).
 *
 * The backend's `record_type` query param is a single string, so multi-type search
 * is necessarily a client-side fan-out. Same scope-filter wire format as useRecordSearch.
 */
export function useMultiTypeSearch(
  query: string,
  recordTypes: string[],
  scope: ScopeFilter | null = null,
  debounceMs = DEFAULT_DEBOUNCE_MS,
): UseMultiTypeSearchResult {
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqIdRef = useRef(0);

  const trimmed = query.trim();
  const typesKey = recordTypes.join(',');
  const scopeKey = scope ? scopeFilterKey(scope) : '';

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!trimmed || recordTypes.length === 0) {
      // Bump the request id so any in-flight Promise.all from a prior query
      // fails the `myReqId === reqIdRef.current` guard and can't overwrite
      // the cleared results.
      reqIdRef.current++;
      setResults([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    timerRef.current = setTimeout(() => {
      const myReqId = ++reqIdRef.current;
      const promises = recordTypes.map((rt) => {
        const params = new URLSearchParams({
          q: trimmed,
          limit: String(PER_TYPE_LIMIT),
          record_type: rt,
        });
        if (scope) applyScopeToParams(params, scope);
        return apiClient
          .get<{ results?: SearchResult[] }>(`${SEARCH_PATH}?${params.toString()}`)
          .then((d) => d?.results ?? [])
          .catch(() => [] as SearchResult[]);
      });
      Promise.all(promises).then((groups) => {
        if (myReqId !== reqIdRef.current) return;
        const merged = groups.flat().sort((a, b) => {
          const ta = a.modified_at ? Date.parse(a.modified_at) : 0;
          const tb = b.modified_at ? Date.parse(b.modified_at) : 0;
          return tb - ta;
        });
        setResults(merged);
        setIsLoading(false);
      });
    }, debounceMs);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [trimmed, typesKey, scopeKey, debounceMs, recordTypes, scope]);

  return { results, isLoading };
}
