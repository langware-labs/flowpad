import type { SearchRow } from './search-row';
import { useEffect, useRef, useState } from 'react';
import apiClient from '@sdk/client';
import type { AssetFilter } from '@src/components/assets/assetFilter';
import { applyFilterToParams } from '@src/components/assets/assetFilter';

/** A row from the `/search` endpoint. Shared fields live in `SearchRow`. */
export interface SearchResult extends SearchRow {
  snippet: string | null;
  // Extra entity-specific fields (optional, populated when available)
  filename?: string;
  asset_type?: string;
  remote?: boolean;
  /** Group-task member pointer — member tasks are hidden from asset lists. */
  parent_id?: string;
}

export interface UseAssetSearchParams {
  recordType: string | null;
  filter: AssetFilter;
  page: number;
  pageSize: number;
  refreshKey?: number;
}

export interface UseAssetSearchResult {
  results: SearchResult[];
  total: number;
  isLoading: boolean;
  page: number;
  pageSize: number;
  setPage: (p: number) => void;
}

export function useAssetSearch(params: UseAssetSearchParams): UseAssetSearchResult {
  const { recordType, filter, pageSize, refreshKey } = params;

  const [page, setPage] = useState(params.page);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(false);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);

  const filterKey = JSON.stringify(filter);

  useEffect(() => {
    if (!recordType) {
      setResults([]);
      setTotal(0);
      setIsLoading(false);
      return;
    }

    if (timerRef.current) clearTimeout(timerRef.current);
    cancelledRef.current = false;

    const debouncedQuery = filter.query.length > 0 && filter.query.length < 2;
    if (debouncedQuery) {
      // Wait for at least 2 chars before searching
      return;
    }

    const delay = filter.query.length >= 2 ? 300 : 0;

    timerRef.current = setTimeout(() => {
      const offset = (page - 1) * pageSize;
      const urlParams = new URLSearchParams();
      urlParams.set('record_type', recordType);
      urlParams.set('offset', String(offset));
      urlParams.set('limit', String(pageSize));

      if (filter.query.length >= 2) {
        urlParams.set('q', filter.query);
      }

      applyFilterToParams(urlParams, filter);

      setIsLoading(true);

      apiClient
        .get(`/search?${urlParams.toString()}`)
        .then((data: unknown) => {
          if (cancelledRef.current) return;
          const d = data as { results?: SearchResult[]; total?: number } | null;
          // Child tasks are NOT filtered out. They used to be, on the theory
          // that a member task belongs in its group task's editor — but that
          // assumes the parent is local, and on the ASSIGNEE's machine the
          // parent is a read-only mirror, so the one row they actually own
          // vanished from every list. The asset tree nests children under a
          // present parent and roots the rest (`buildTaskTree`), which is the
          // right place for that presentation decision.
          setResults(d?.results ?? []);
          setTotal(d?.total ?? 0);
          setIsLoading(false);
        })
        .catch(() => {
          if (cancelledRef.current) return;
          setResults([]);
          setTotal(0);
          setIsLoading(false);
        });
    }, delay);

    return () => {
      cancelledRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordType, filterKey, page, pageSize, refreshKey]);

  return { results, total, isLoading, page, pageSize, setPage };
}
