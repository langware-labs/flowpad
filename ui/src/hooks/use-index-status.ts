import { useCallback } from 'react';
import { LazyAsset } from '@sdk/lazy';
import { useLazyAsset } from '@sdk/react/hooks/useLazyAsset';
import type { ScopeFilter } from '@sdk/utils/scope-filter';
import type { IndexStatus, IndexStatusPerType } from '@sdk/lazy/assets';
export type { IndexStatus, IndexStatusPerType } from '@sdk/lazy/assets';

export type IndexStatusState =
  | { phase: 'loading' }
  | { phase: 'error'; error: Error }
  | { phase: 'ready'; status: IndexStatus };
export interface UseIndexStatusResult { state: IndexStatusState; refresh: () => void }

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

export function useIndexStatus(scope?: ScopeFilter): UseIndexStatusResult {
  const { data, error, reload } = useLazyAsset(LazyAsset.IndexStatus, { scope }, { priority: 'background' });
  const refresh = useCallback(() => { void reload().catch(() => {}); }, [reload]);
  const state: IndexStatusState = data ? { phase: 'ready', status: data } :
    error ? { phase: 'error', error } : { phase: 'loading' };
  return { state, refresh };
}
