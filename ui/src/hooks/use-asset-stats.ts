import { LazyAsset } from '@sdk/lazy';
import { EMPTY_ASSET_STATS } from '@sdk/lazy/assets';
import { useLazyAsset } from '@sdk/react/hooks/useLazyAsset';
import type { ScopeFilter } from '@sdk/utils/scope-filter';
export type { AssetStats } from '@sdk/lazy/assets';

/** Live counts and invalidation are owned once per scoped registry entry. */
export function useAssetStats(scope?: ScopeFilter) {
  const { data, isLoading, error, reload } = useLazyAsset(LazyAsset.AssetStats, { scope }, { priority: 'background' });
  return { stats: data ?? EMPTY_ASSET_STATS, isLoading, error, reload };
}
