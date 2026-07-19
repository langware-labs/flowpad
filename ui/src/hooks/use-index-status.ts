import { useCallback, useEffect, useState } from 'react';
import apiClient from '@sdk/client';
import { applyScopeToParams, scopeFilterKey, type ScopeFilter } from '@src/lib/scope-filter';
import { isHubOnly } from '@src/navigation/hub-runtime';

const STATUS_PATH = '/graph/compute_node/@local/fs-records/index-status';

export interface IndexStatusPerType {
  type_name: string;
  last_indexed_at: string | null;
  entity_count: number;
  stale: boolean;
  orphan_count: number;
}

export interface IndexStatus {
  never_indexed: boolean;
  last_indexed_at: string | null;
  stale: boolean;
  default_types: string[];
  per_type?: IndexStatusPerType[];
  total_orphans: number;
}

export type IndexStatusState =
  | { phase: 'loading' }
  | { phase: 'ready'; status: IndexStatus };

export interface UseIndexStatusResult {
  state: IndexStatusState;
  refresh: () => void;
}

/**
 * Pure projection: per-type index rows → `Map<type_name, entity_count>`.
 * Lets the asset sidebar source every type's count badge from the single
 * `index-status` response (one request) instead of one `/search?limit=1` probe
 * per type row. Dependency-free so it's unit-testable in isolation.
 */
export function typeCountsFromPerType(perType: IndexStatusPerType[] | undefined): Map<string, number> {
  const m = new Map<string, number>();
  for (const pt of perType ?? []) m.set(pt.type_name, pt.entity_count);
  return m;
}

const EMPTY_STATUS: IndexStatus = {
  never_indexed: false,
  last_indexed_at: null,
  stale: false,
  default_types: [],
  per_type: [],
  total_orphans: 0,
};

/**
 * Fetch `/fs-records/index-status` (optionally scoped by ScopeFilter so the
 * per-type entity_count and orphan_count narrow to the same row set the
 * assets/scanner surface is acting on).
 */
export function useIndexStatus(scope?: ScopeFilter): UseIndexStatusResult {
  const [state, setState] = useState<IndexStatusState>({ phase: 'loading' });

  const scopeKey = scope ? scopeFilterKey(scope) : '';

  const refresh = useCallback(() => {
    // Hub mode: no local fs-records `/index-status` endpoint (404). Settle
    // immediately on an empty (idle, nothing-indexed) status — never fetch.
    if (isHubOnly()) {
      setState({ phase: 'ready', status: EMPTY_STATUS });
      return;
    }
    let url = STATUS_PATH;
    if (scope) {
      const p = new URLSearchParams();
      applyScopeToParams(p, scope);
      url = `${STATUS_PATH}?${p.toString()}`;
    }
    apiClient
      .get(url)
      .then((data: unknown) => {
        // Defensive: if the API returns null/undefined or shape unexpectedly
        // lacks fields, fall back to EMPTY_STATUS — never expose a null
        // `status` field to consumers, since downstream code reads
        // `status.per_type` etc. directly.
        const incoming = (data && typeof data === 'object') ? (data as Partial<IndexStatus>) : null;
        const per_type: IndexStatusPerType[] = (incoming?.per_type ?? []).map((pt) => ({
          type_name: pt.type_name,
          last_indexed_at: pt.last_indexed_at ?? null,
          entity_count: pt.entity_count ?? 0,
          stale: pt.stale ?? false,
          orphan_count: pt.orphan_count ?? 0,
        }));
        const status: IndexStatus = incoming
          ? {
              never_indexed: incoming.never_indexed ?? EMPTY_STATUS.never_indexed,
              last_indexed_at: incoming.last_indexed_at ?? null,
              stale: incoming.stale ?? false,
              default_types: incoming.default_types ?? [],
              per_type,
              total_orphans: incoming.total_orphans ?? per_type.reduce((s, p) => s + p.orphan_count, 0),
            }
          : EMPTY_STATUS;
        setState({ phase: 'ready', status });
      })
      .catch(() => {
        // On error assume ok — don't block search
        setState({ phase: 'ready', status: EMPTY_STATUS });
      });
    // scopeKey is part of useCallback's dep list so refresh changes identity
    // when the chip changes — useEffect below picks that up and re-fetches.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { state, refresh };
}
