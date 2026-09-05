import { setSupportedPagesForHubMode } from '@sdk/utils/hub-runtime';
import apiClient from '@sdk/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryObserver } from '@tanstack/query-core';
import { afterEach, expect, it, vi } from 'vitest';
import { LazyAssetRegistry, lazyAssets, LazyAsset } from '@sdk/lazy';
import { assetDefinitions } from '@sdk/lazy/assets';
import { useLazyAsset } from '@sdk/react/hooks/useLazyAsset';
import { PrimaryContentProvider, PrimaryContentRegion, usePrimaryContentPending } from '@sdk/react/primary-content';

function deferred<T>() {
  let resolve!: (data: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const clients: QueryClient[] = [];
function registry(load: () => Promise<{ types: [] }>) {
  const client = new QueryClient();
  clients.push(client);
  return new LazyAssetRegistry(client, { ...assetDefinitions, [LazyAsset.AssetCatalog]: { load } });
}
afterEach(() => { clients.forEach(client => client.clear()); lazyAssets.client.clear(); vi.restoreAllMocks(); setSupportedPagesForHubMode(['desk', 'hub']); });

it('coalesces prefetch, concurrent access and refresh; caches an empty result', async () => {
  const pending = deferred<{ types: [] }>();
  let calls = 0;
  const assets = registry(() => { calls++; return pending.promise; });
  const reads = [assets.prefetch(LazyAsset.AssetCatalog), assets.load(LazyAsset.AssetCatalog), assets.refresh(LazyAsset.AssetCatalog)];
  pending.resolve({ types: [] });
  await Promise.all(reads);
  expect(calls).toBe(1);
  expect(await assets.load(LazyAsset.AssetCatalog)).toEqual({ types: [] });
  expect(calls).toBe(1);
});

it('rejects locally and retries only on explicit access', async () => {
  let calls = 0;
  const assets = registry(() => ++calls === 1 ? Promise.reject(new Error('offline')) : Promise.resolve({ types: [] }));
  await expect(assets.load(LazyAsset.AssetCatalog)).rejects.toThrow('offline');
  expect(assets.client.getQueryState(assets.key(LazyAsset.AssetCatalog))?.status).toBe('error');
  expect(calls).toBe(1);
  await assets.refresh(LazyAsset.AssetCatalog);
  expect(calls).toBe(2);
});

it('isolates identities and rejects a late result from the previous scope', async () => {
  const pending = deferred<{ types: [] }>();
  const assets = registry(() => pending.promise);
  assets.setScope('first');
  const old = assets.load(LazyAsset.AssetCatalog);
  const rejected = expect(old).rejects.toThrow();
  assets.setScope('second');
  pending.resolve({ types: [] });
  await rejected;
  expect(assets.client.getQueryData(assets.key(LazyAsset.AssetCatalog))).toBeUndefined();
  expect(await assets.load(LazyAsset.AssetCatalog)).toEqual({ types: [] });
});

it('normalizes scope order, distinguishes project resources and removes live subscriptions', async () => {
  const client = new QueryClient(); clients.push(client);
  let unsubscribed = 0;
  let publish!: (data: { types: [] }) => void;
  const assets = new LazyAssetRegistry(client, { ...assetDefinitions, [LazyAsset.AssetCatalog]: {
    load: () => Promise.resolve({ types: [] }),
    subscribe: (_params, update) => { publish = update; return () => { unsubscribed++; }; },
  } });
  const key = (projects: string[]) => assets.key(LazyAsset.IndexStatus, { scope: { mode: 'filter', projects } });
  expect(key(['a', 'b'])).toEqual(key(['b', 'a']));
  expect(key(['a'])).not.toEqual(key(['b']));
  await assets.load(LazyAsset.AssetCatalog);
  const next = { types: [] as [] };
  publish(next);
  expect(client.getQueryData(assets.key(LazyAsset.AssetCatalog))).toBe(next);
  assets.setScope('next');
  expect(unsubscribed).toBe(1);
});

it('multiple hooks join an imperative pending load and unmount does not cancel it', async () => {
  const pending = deferred<{ types: [] }>();
  let calls = 0;
  const key = lazyAssets.key(LazyAsset.AssetCatalog);
  const read = lazyAssets.client.fetchQuery({ queryKey: key, queryFn: () => { calls++; return pending.promise; } });
  const first = renderHook(() => useLazyAsset(LazyAsset.AssetCatalog));
  const second = renderHook(() => useLazyAsset(LazyAsset.AssetCatalog));
  first.unmount();
  await act(async () => { pending.resolve({ types: [] }); await read; });
  await waitFor(() => expect(second.result.current.data).toEqual({ types: [] }));
  expect(calls).toBe(1);
  second.unmount();
});

it('a primary consumer demand-loads its asset before its own readiness', async () => {
  const pending = deferred<{ types: [] }>();
  const call = vi.spyOn(apiClient, 'get').mockReturnValue(pending.promise);
  const view = renderHook(() => {
    const resource = useLazyAsset(LazyAsset.AssetCatalog);
    usePrimaryContentPending(resource.isLoading);
    return resource;
  }, { wrapper: ({ children }) => <PrimaryContentProvider navigationKey="one"><PrimaryContentRegion>{children}</PrimaryContentRegion></PrimaryContentProvider> });
  await waitFor(() => expect(call).toHaveBeenCalledOnce());
  expect(view.result.current.isPending).toBe(true);
  await act(async () => { pending.resolve({ types: [] }); await pending.promise; });
  await waitFor(() => expect(view.result.current.isPending).toBe(false));
  view.unmount();
});

it('a background hook issues no read while the primary view is pending', () => {
  const call = vi.spyOn(apiClient, 'get');
  const view = renderHook(() => {
    usePrimaryContentPending(true);
    return useLazyAsset(LazyAsset.AssetCatalog, undefined, { priority: 'background' });
  }, { wrapper: ({ children }) => <PrimaryContentProvider navigationKey="one"><PrimaryContentRegion>{children}</PrimaryContentRegion></PrimaryContentProvider> });
  expect(view.result.current.isPending).toBe(true);
  expect(call).not.toHaveBeenCalled();
  view.unmount();
});

it('coalesces live invalidations during a pending read and refreshes the observed entry afterward', async () => {
  const pending = deferred<{ types: [] }>();
  let calls = 0;
  const assets = registry(() => ++calls === 1 ? pending.promise : Promise.resolve({ types: [] }));
  const observer = new QueryObserver(assets.client, assets.options(LazyAsset.AssetCatalog));
  const off = observer.subscribe(() => {});
  const invalidations = [assets.invalidate(LazyAsset.AssetCatalog), assets.invalidate(LazyAsset.AssetCatalog)];
  expect(calls).toBe(1);
  pending.resolve({ types: [] });
  await Promise.all(invalidations);
  expect(calls).toBe(2);
  off();
});

it('skips desktop-only metadata routes on the actual hub runtime contract', async () => {
  setSupportedPagesForHubMode(['hub']);
  const get = vi.spyOn(apiClient, 'get');
  await Promise.all([
    lazyAssets.load(LazyAsset.AssetCatalog), lazyAssets.load(LazyAsset.IndexStatus), lazyAssets.load(LazyAsset.AssetStats),
    lazyAssets.load(LazyAsset.Bookmarks), lazyAssets.load(LazyAsset.RagIndexes), lazyAssets.load(LazyAsset.CloudStatus),
    lazyAssets.load(LazyAsset.Capabilities), lazyAssets.load(LazyAsset.Activities), lazyAssets.load(LazyAsset.IndexActivity),
    lazyAssets.load(LazyAsset.Connections), lazyAssets.load(LazyAsset.LlmFunding),
  ]);
  expect(get).not.toHaveBeenCalled();
});
