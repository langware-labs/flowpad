import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import apiClient from '@sdk/client';
import { useAssetSearch } from '@src/hooks/use-asset-search';
import { DEFAULT_ASSET_FILTER } from '@src/components/assets/assetFilter';
vi.mock('@sdk/client', () => ({ default: { get: vi.fn() } }));
afterEach(() => { vi.useRealTimers(); vi.mocked(apiClient.get).mockReset(); });
it('review probe: an older asset-search response must not replace the newer response', async () => {
  vi.useFakeTimers();
  const resolvers = new Map<string, (value: unknown) => void>();
  vi.mocked(apiClient.get).mockImplementation((url: string) => new Promise(resolve => {
    resolvers.set(new URL(url, 'http://flowpad.local').searchParams.get('q') ?? '', resolve);
  }));
  const { result, rerender } = renderHook(({ query }) => useAssetSearch({
    recordType: 'markdown', filter: { ...DEFAULT_ASSET_FILTER, query }, page: 1, pageSize: 20,
  }), { initialProps: { query: 'older' } });
  await act(async () => vi.runOnlyPendingTimersAsync());
  rerender({ query: 'newer' });
  await act(async () => vi.runOnlyPendingTimersAsync());
  await act(async () => { resolvers.get('newer')?.({ results: [{ name: 'newer' }], total: 1 }); });
  expect(result.current.results.map(row => row.name)).toEqual(['newer']);
  await act(async () => { resolvers.get('older')?.({ results: [{ name: 'older' }], total: 1 }); });
  expect(result.current.results.map(row => row.name)).toEqual(['newer']);
});
