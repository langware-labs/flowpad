import apiClient from '@sdk/client';
import { useEntityOps } from '@sdk/react/hooks';
import { scopeFilterKey, scopeToQueryString, type ScopeFilter } from '@src/lib/scope-filter';
import { isHubOnly } from '@src/navigation/hub-runtime';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

const STATS_PATH = '/graph/compute_node/@local/fs-records/asset-stats';
const QUERY_KEY = 'asset-stats';

/**
 * Live per-type asset counts for a scope — the single source every counter
 * surface renders from (SummaryDashboard cards, asset-tree badges). Counts
 * only; indexer freshness/orphans stay on {@link useIndexStatus}.
 */
export interface AssetStats {
  /** `{ type_name: count }` over the registry's default index types. */
  per_type: Record<string, number>;
  total: number;
}

const EMPTY_STATS: AssetStats = { per_type: {}, total: 0 };

/**
 * Fetch `/fs-records/asset-stats` (optionally scoped). All callers with the
 * same scope share one request (react-query dedupes by key). The hook
 * subscribes to create/update/delete ops for every asset type and invalidates
 * on any of them, so counts update live without a reload — the reactivity
 * `useIndexStatus` lacks. Mirrors `use-entity-by-path`'s invalidation pattern.
 */
export function useAssetStats(scope?: ScopeFilter): { stats: AssetStats; isLoading: boolean } {
  const scopeKey = scope ? scopeFilterKey(scope) : '';

  const { data, isLoading } = useQuery<AssetStats>({
    queryKey: [QUERY_KEY, scopeKey],
    // Hub mode: no local fs-records `/asset-stats` endpoint (404). Skip the
    // fetch and report empty counts.
    enabled: !isHubOnly(),
    queryFn: async () => {
      const qs = scope ? scopeToQueryString(scope) : '';
      const raw = await apiClient.get<Partial<AssetStats>>(qs ? `${STATS_PATH}?${qs}` : STATS_PATH);
      const per_type: Record<string, number> = raw?.per_type ?? {};
      const total = raw?.total ?? Object.values(per_type).reduce((s, n) => s + n, 0);
      return { per_type, total };
    },
  });

  const stats = data ?? EMPTY_STATS;

  // Subscribe to the asset types the backend reported (registry-derived, not a
  // hardcoded list). Keyed on the sorted type set so the subscription is stable
  // across refetches — only a change in the *set* of types re-subscribes, not
  // every count change. Any asset op invalidates all scoped asset-stats queries.
  const typeKey = Object.keys(stats.per_type).sort().join(',');
  const assetTypes = useMemo(() => (typeKey ? typeKey.split(',') : []), [typeKey]);
  const queryClient = useQueryClient();
  const onAssetOp = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: [QUERY_KEY] });
  }, [queryClient]);
  useEntityOps(assetTypes, onAssetOp);

  return { stats, isLoading };
}
