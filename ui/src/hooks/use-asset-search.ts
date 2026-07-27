import { useEffect, useRef, useState } from 'react';
import apiClient from '@sdk/client';
import type { AssetFilter } from '@src/components/assets/assetFilter';
import { applyFilterToParams } from '@src/components/assets/assetFilter';

export interface SearchResult {
  record_id: string;
  record_type: string;
  name: string;
  snippet: string | null;
  status: string;
  scope: string;
  asset_ref: string;
  created_at: string;
  modified_at: string;
  // Extra entity-specific fields (optional, populated when available)
  uname?: string;
  title?: string;
  description?: string;
  file_path?: string;
  filename?: string;
  work_dir?: string;
  project_id?: string;
  project_name?: string;
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
          const rows = d?.results ?? [];
          // Member tasks (group-task children) live in their group task's
          // editor ("Member tasks" section), not the asset lists.
          const visible = recordType === 'task' ? rows.filter((r) => !r.parent_id) : rows;
          setResults(visible);
          setTotal((d?.total ?? 0) - (rows.length - visible.length));
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
