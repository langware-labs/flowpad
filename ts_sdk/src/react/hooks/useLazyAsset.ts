import { hashKey } from '@tanstack/query-core';
import { useCallback, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { lazyAssets, LazyAsset, type AssetData, type AssetParams } from '../../lazy';
import { usePrimaryContentReady } from '../primary-content';

export interface UseLazyAssetOptions {
  enabled?: boolean;
  /** Adapters for specialized queries can opt out of this observer entirely. */
  subscribed?: boolean;
  /** Background widgets wait for primary content; opened controls demand-load immediately. */
  priority?: 'demand' | 'background';
}

export function useLazyAsset<A extends LazyAsset>(asset: A, params?: AssetParams<A>, options: UseLazyAssetOptions = {}) {
  useSyncExternalStore(lazyAssets.subscribe, lazyAssets.getScope, lazyAssets.getScope);
  const primaryReady = usePrimaryContentReady();
  const enabled = options.enabled !== false;
  const queryOptions = lazyAssets.options(asset, params);
  const result = useQuery<AssetData<A>>({
    ...queryOptions,
    subscribed: options.subscribed !== false,
    enabled: enabled && (options.priority !== 'background' || primaryReady),
    refetchOnWindowFocus: false,
    retryOnMount: false,
  }, lazyAssets.client);
  const key = hashKey(queryOptions.queryKey);
  // reload is an explicit demand even while background prefetch is gated.
  const reload = useCallback(() => lazyAssets.refresh(asset, params), [asset, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return {
    ...result,
    isPending: enabled && result.isPending,
    isLoading: enabled && result.isPending,
    isRefreshing: result.isFetching && result.data !== undefined,
    reload,
  };
}
