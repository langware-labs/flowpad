/**
 * `searchRecords` is the SDK's call for the record search index (`GET /api/v1/search`) — until now
 * only private UI code reached it. And a query request no longer drops what it does not read.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryFilter, QueryRequest, searchRecords } from '@sdk';
import apiClient from '@sdk/client';

afterEach(() => vi.restoreAllMocks());

describe('searchRecords', () => {
  it('asks the search route with the query and the options the route reads', async () => {
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue({ results: [{ record_id: 'r1', record_type: 'task', name: 'Call Dana' }], query: 'dana', total: 1, indexer_ready: true } as never);
    const found = await searchRecords('dana', { limit: 5, record_type: 'task', projects: ['p1', 'p2'], tags: ['crm'] });
    expect(get).toHaveBeenCalledWith('/search', { params: { q: 'dana', limit: 5, record_type: 'task', projects: 'p1,p2', tags: 'crm' } });
    expect(found.results[0].name).toBe('Call Dana');
    expect(found.total).toBe(1);
  });

  it('answers an empty result, not null, when the server says nothing', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(null as never);
    expect(await searchRecords('x')).toEqual({ results: [], query: 'x', total: 0, indexer_ready: true });
  });

  it('sends no list filters it was not given', async () => {
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue({} as never);
    await searchRecords('x');
    expect(get).toHaveBeenCalledWith('/search', { params: { q: 'x' } });
  });
});

describe('a query request says what it does not read', () => {
  it('refuses a key it would have dropped (a top-level limit asked for everything)', () => {
    expect(() => new QueryRequest({ type: 'source_item', limit: 3 } as never)).toThrow(/unknown 'limit'.*query/);
  });

  it('takes paging where it belongs', () => {
    const request = new QueryRequest({ type: 'source_item', query: new QueryFilter({ limit: 3 }) });
    expect(request.query?.limit).toBe(3);
  });

  it('a plain {limit} is a page, not "the rows whose limit is 3"', () => {
    const request = new QueryRequest({ type: 'source_item', query: { limit: 3, offset: 6 } });
    expect([request.query?.limit, request.query?.offset, request.query?.match]).toEqual([3, 6, undefined]);
  });

  it('a plain map with a field is still the match', () => {
    const request = new QueryRequest({ type: 'task', query: { status: 'open' } });
    expect(request.query?.validate({ status: 'open' })).toBe(true);
    expect(request.query?.validate({ status: 'done' })).toBe(false);
  });
});
