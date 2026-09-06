import { dataManager, QueryRequest } from '@sdk';
import apiClient from '@sdk/client';
import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => vi.restoreAllMocks());
it('review probe: a cold watch registers and removes one callback', async () => {
  vi.spyOn(apiClient, 'get').mockResolvedValue([] as never);
  const request = new QueryRequest({ type: 'markdown', name: 'data-management-review-only',
    query: { match: { name: 'data-management-review-only' } }, callback: () => {} });
  const unsubscribe = await dataManager.watchQuery(request);
  const map = (dataManager as any).watchedQueries;
  const registered = map.getWatchedQuery(request)?.getQueryCallbacks().length ?? 0;
  unsubscribe();
  const remaining = map.getWatchedQuery(request)?.getQueryCallbacks().length ?? 0;
  expect({ registered, remaining }).toEqual({ registered: 1, remaining: 0 });
});
