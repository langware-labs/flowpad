/**
 * `useEntitiesQuery` on a paged request: the first page is the live watched query, `hasMore` is the
 * server's `has_more`, and `loadMore()` asks the same request again right after the server's
 * `next_cursor` (as `after`) when it gave one, else at its `next_offset` — inside `filter`, never
 * top-level — and appends what it answers.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataManager, QueryFilter, QueryRequest, Tab } from '@sdk';
import apiClient from '@sdk/client';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';

const ids = [
  'a1111111-1111-4111-8111-111111111111',
  'b2222222-2222-4222-8222-222222222222',
  'c3333333-3333-4333-8333-333333333333',
];
const tab = (id: string) => ({ type: 'tab', id, pointer: `lens|x/${id}`, visible: true, lane: 'load-more' });
const page = (rows: string[], has_more: boolean, next_offset: number, next_cursor: string | null = null) =>
  Object.assign(rows.map(tab), { has_more, next_offset, next_cursor });

describe('useEntitiesQuery: hasMore + loadMore', () => {
  beforeEach(async () => {
    await dataManager.clearCache();
    vi.restoreAllMocks();
  });
  afterEach(() => vi.restoreAllMocks());

  it('appends the next page from next_offset and stops when the server has no more', async () => {
    const offsets: unknown[] = [];
    vi.spyOn(apiClient, 'get').mockImplementation((async (_url: string, config?: { params?: any }) => {
      const filter = config?.params?.filter ?? {};
      offsets.push(filter.offset);
      expect(config?.params?.limit).toBeUndefined();
      expect(config?.params?.offset).toBeUndefined();
      // The server's next_offset need not be offset + rows: 5 here, past rows it filtered out.
      return filter.offset === 5 ? page([ids[2]], false, 6) : page([ids[0], ids[1]], true, 5);
    }) as never);
    const request = new QueryRequest({
      type: Tab.type,
      query: new QueryFilter({ match: { lane: 'load-more' }, limit: 2 }),
      name: 'load-more',
    });

    const { result } = renderHook(() => useEntitiesQuery<Tab>(request));
    await waitFor(() => expect(result.current.data?.map((t) => t.id)).toEqual([ids[0], ids[1]]));
    expect(result.current.hasMore).toBe(true);

    await act(async () => {
      await result.current.loadMore?.();
    });

    expect(result.current.data?.map((t) => t.id)).toEqual(ids);
    expect(result.current.hasMore).toBe(false);
    expect(offsets).toEqual([undefined, 5]);
  });

  it('appends the next page after next_cursor, sending after and no offset', async () => {
    const asked: { offset?: unknown; after?: unknown }[] = [];
    vi.spyOn(apiClient, 'get').mockImplementation((async (_url: string, config?: { params?: any }) => {
      const filter = config?.params?.filter ?? {};
      asked.push({ offset: filter.offset, after: filter.after });
      if (filter.after === 'cur-2') return page([ids[2]], false, 1);
      if (filter.after === 'cur-1') return page([ids[1]], true, 1, 'cur-2');
      return page([ids[0]], true, 1, 'cur-1');
    }) as never);
    const request = new QueryRequest({
      type: Tab.type,
      query: new QueryFilter({ match: { lane: 'load-more' }, limit: 1 }),
      name: 'load-more-cursor',
    });

    const { result } = renderHook(() => useEntitiesQuery<Tab>(request));
    await waitFor(() => expect(result.current.data?.map((t) => t.id)).toEqual([ids[0]]));
    for (let i = 0; i < 2; i++) {
      await act(async () => {
        await result.current.loadMore?.();
      });
    }

    expect(result.current.data?.map((t) => t.id)).toEqual(ids);
    expect(result.current.hasMore).toBe(false);
    expect(asked).toEqual([
      { offset: undefined, after: undefined },
      { offset: undefined, after: 'cur-1' },
      { offset: undefined, after: 'cur-2' },
    ]);
  });

  it('an unpaged request has no more and loadMore asks nothing', async () => {
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue([tab(ids[0])] as never);
    const request = new QueryRequest({ type: Tab.type, query: new QueryFilter({ match: { lane: 'unpaged' } }) });
    const { result } = renderHook(() => useEntitiesQuery<Tab>(request));
    await waitFor(() => expect(result.current.data?.length).toBe(1));
    expect(result.current.hasMore).toBe(false);
    get.mockClear();
    await act(async () => {
      await result.current.loadMore?.();
    });
    expect(get).not.toHaveBeenCalled();
  });
});
