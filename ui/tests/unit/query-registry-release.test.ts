/**
 * The watch registry holds a query for as long as someone subscribes to it or
 * its fetch is in flight — and no longer. A one-shot `query()` has no
 * unsubscribe, so its entry must go when the fetch settles; a `watchQuery`
 * subscribes its callback exactly once, so its unsubscribe empties the entry.
 *
 * Driven through the real `DataManager` (`query` / `watchQuery` / `onDataOp` /
 * `refreshAll`); the only stand-in is the HTTP boundary, `apiClient.get`.
 */
import { DataManager, QueryFilter, QueryRequest, Tab, TypeId, type WatchedQuery } from '@sdk';
import apiClient from '@sdk/client';
import { ConnectionManager } from '@sdk/websocket';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEYS = 50;
const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const tabJson = (i: number, extra: object = {}) => ({ type: 'tab', id: uuid(i), pointer: `p|${i}`, visible: true, n: i, ...extra });
/** One distinct registry key per `n` — the shape of a query that carries an id. */
const requestFor = (n: number, callback?: (rows: unknown[]) => void) =>
  new QueryRequest({ type: Tab.type, query: new QueryFilter({ match: { n } }), callback });

let dm: InstanceType<typeof DataManager>;
const registry = (): WatchedQuery[] =>
  (dm as unknown as { watchedQueries: { getAllWatchedQueries(): WatchedQuery[] } }).watchedQueries.getAllWatchedQueries();
const dataOp = (op: string, i: number, extra: object = {}) =>
  dm.onDataOp(new TypeId('tab', uuid(i)).toString(), op as never, tabJson(i, extra));

beforeEach(() => {
  dm = new DataManager();
});

afterEach(() => {
  dm.detach_connection_manager(ConnectionManager.getInstance());
  vi.restoreAllMocks();
});

describe('watch registry: an entry lives only while watched or in flight', () => {
  it('a one-shot query leaves nothing behind, on any number of distinct keys', async () => {
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue([tabJson(1)] as never);

    for (let n = 0; n < KEYS; n++) {
      const request = requestFor(n);
      expect(await dm.query(request)).toHaveLength(1);
      expect(dm.getCachedQueryResults(request)).toBeUndefined();
    }
    expect(registry()).toHaveLength(0);

    // Nothing is left to collect later creates, or to be re-fetched by a refresh.
    get.mockClear();
    dataOp('create', 1000, { n: 0 });
    await dm.refreshAll();
    expect(registry()).toHaveLength(0);
    expect(get.mock.calls.filter(([url]) => String(url).endsWith('/tab'))).toHaveLength(0);
  });

  it('a one-shot query that fails leaves nothing behind', async () => {
    vi.spyOn(apiClient, 'get').mockRejectedValue(new Error('boom'));

    for (let n = 0; n < KEYS; n++) await expect(dm.query(requestFor(n))).rejects.toThrow('boom');

    expect(registry()).toHaveLength(0);
  });

  it('a watch subscribes its callback once and unsubscribing releases the entry', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue([tabJson(1)] as never);
    let notified = 0;
    const request = requestFor(1, () => notified++);

    const unsubscribe = await dm.watchQuery(request);
    expect(registry()).toHaveLength(1);
    expect(registry()[0].getQueryCallbacks()).toHaveLength(1);
    expect(notified).toBe(1); // the seed

    dataOp('update', 1, { pointer: 'changed' });
    expect(notified).toBe(2); // one data-op, one notification

    unsubscribe();
    expect(registry()).toHaveLength(0);
  });

  it('a watch that fails to start leaves nothing behind', async () => {
    vi.spyOn(apiClient, 'get').mockRejectedValue(new Error('boom'));

    for (let n = 0; n < KEYS; n++) await expect(dm.watchQuery(requestFor(n, () => undefined))).rejects.toThrow('boom');

    expect(registry()).toHaveLength(0);
  });

  it('callers on one in-flight key share a single fetch, and a watch among them stays live', async () => {
    let respond!: (rows: unknown[]) => void;
    const get = vi.spyOn(apiClient, 'get').mockImplementation((() => new Promise((resolve) => (respond = resolve))) as never);
    const seen: number[] = [];

    const first = dm.query(requestFor(7));
    const second = dm.query(requestFor(7));
    const watching = dm.watchQuery(requestFor(7, (rows) => seen.push(rows.length)));
    await Promise.resolve();
    expect(get).toHaveBeenCalledTimes(1);

    respond([tabJson(7)]);
    expect(await first).toHaveLength(1);
    expect(await second).toHaveLength(1);
    const unsubscribe = await watching;
    expect(get).toHaveBeenCalledTimes(1);

    dataOp('create', 8, { n: 7 });
    expect(seen).toEqual([1, 2]);

    unsubscribe();
    expect(registry()).toHaveLength(0);
  });

  it('a one-shot query on a watched key is answered from the watch, without a fetch', async () => {
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue([tabJson(1)] as never);
    const unsubscribe = await dm.watchQuery(requestFor(1, () => undefined));
    get.mockClear();

    expect(await dm.query(requestFor(1))).toHaveLength(1);
    expect(get).not.toHaveBeenCalled();
    expect(registry()).toHaveLength(1);

    unsubscribe();
  });
});
