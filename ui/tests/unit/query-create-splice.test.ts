/**
 * Regression test for X5a — the per-data-op LIST refetch on `create`.
 *
 * Bug: `onDataOp`'s `create` branch ran a full network `_query` LIST refetch
 * for every matching watched query, even though the data-op payload already
 * carries (and locally materializes) the full entity. Every incoming `create`
 * data-op therefore cost one redundant LIST GET (e.g. the triggers/cron
 * `graph/trigger` 7→15 idle climb), and this is the SHARED SDK path (tabs,
 * stream inbox, feed, workflows, triggers…).
 *
 * Fix: ts_sdk/src/FlowSync/store.ts `onDataOp` — on `create`, splice the
 * already-delivered entity into each matching WatchedQuery's results locally
 * and notify (mirror of `removeEntityFromResults` for delete, via the new
 * `insertEntityIntoResults` helper in map.ts), gated by the same
 * `query.validate(data)` scope check. No network `_query`.
 *
 * Narrowest reproducing layer: drive `dataManager.onDataOp` directly against a
 * real watched query — no browser, no mocks beyond the initial HTTP fetch.
 */

import { dataManager, QueryFilter, QueryRequest, Tab, TypeId } from '@sdk';
import apiClient from '@sdk/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ID_A = '60c389a8-5ea3-4e41-950e-4d7049099826';
const ID_B = '7b1f4d2c-1c2e-4a9b-8f3d-0a1b2c3d4e5f';

function tabJson(id: string, visible: boolean, extra: object = {}) {
  return { type: 'tab', id, pointer: `lens|claude/transcript/${id}`, visible, ...extra };
}

function fireCreate(id: string, data: object) {
  (dataManager as any).onDataOp(new TypeId('tab', id).toString(), 'create', data);
}

function watchedFor(request: QueryRequest) {
  return (dataManager as any).watchedQueries.getWatchedQuery(request);
}

describe('DataManager: CREATE splices into live queries locally (X5a)', () => {
  beforeEach(async () => {
    await dataManager.clearCache();
    vi.restoreAllMocks();
  });

  afterEach(() => vi.restoreAllMocks());

  it('appends a matching new entity to results with ONE render and ZERO network _query', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue([tabJson(ID_A, true)] as any);
    const seen: number[] = [];
    const request = new QueryRequest({
      type: Tab.type,
      scope: [],
      name: 'test:visibleTabs:create',
      query: new QueryFilter({ match: { visible: true } }),
      callback: (rows: unknown[]) => seen.push(rows.length),
    });

    const unsub = await dataManager.watchQuery(request);
    const wq = watchedFor(request);
    expect(wq.results.length).toBe(1); // initial fetch delivered the first visible tab

    // Restore the spy so the FIX's "splice locally" path is asserted with NO network.
    vi.restoreAllMocks();
    const getSpy = vi.spyOn(apiClient, 'get');
    // One render == one notify batch for the watched query (independent of how many
    // callbacks happen to be registered on it).
    const notifySpy = vi.spyOn(wq, 'notifyCallbacks');

    // A new visible tab arrives as a `create` data-op (payload carries the entity).
    fireCreate(ID_B, tabJson(ID_B, true));

    // BUG (unfixed): a full network LIST GET fired per create data-op.
    // FIX: entity is spliced in locally and the query notifies exactly once.
    expect(wq.results.length).toBe(2);
    expect(seen[seen.length - 1]).toBe(2);
    expect(notifySpy).toHaveBeenCalledTimes(1); // exactly one render, no refetch loop
    expect(getSpy).not.toHaveBeenCalled(); // no network refetch
    expect(wq.results.some((e: any) => e.typeId.equals(new TypeId('tab', ID_B)))).toBe(true);

    unsub();
  });

  it('splices a SELF-created entity, whose ref is still saveInFlight', async () => {
    // The regression this file's first test did not cover. `saveInFlight` is
    // true exactly when THIS client called save() — the common case — and the
    // create data-op then takes the buffering branch, which used to `break`
    // before the splice ran. Field merging is handled there by
    // applyPendingUpdate, but LIST MEMBERSHIP is not a field merge and cannot
    // wait for it: an entity you had just created was missing from your own
    // live query until something unrelated refetched.
    //
    // Seen end-to-end as tests/api/project_id_sync.test.ts — find-or-create
    // queried, did not see the project it had just written, and minted a
    // second one for the same work dir.
    vi.spyOn(apiClient, 'get').mockResolvedValue([tabJson(ID_A, true)] as any);
    const request = new QueryRequest({
      type: Tab.type,
      scope: [],
      name: 'test:visibleTabs:selfCreated',
      query: new QueryFilter({ match: { visible: true, lane: 'self' } }),
      callback: () => {},
    });
    const unsub = await dataManager.watchQuery(request);
    const wq = watchedFor(request);
    const before = wq.results.length;

    // Register a ref for ID_B and mark it mid-save, exactly as save() does.
    const typeId = new TypeId('tab', ID_B);
    const entity = (dataManager as any).castAndDeepAssign(tabJson(ID_B, true, { lane: 'self' }));
    (dataManager as any).register_new_entity(typeId, entity);
    const ref = (dataManager as any).entities.get(typeId);
    ref.saveInFlight = true;

    fireCreate(ID_B, tabJson(ID_B, true, { lane: 'self' }));

    expect(wq.results.length).toBe(before + 1);
    expect(wq.results.some((e: any) => e.typeId.equals(typeId))).toBe(true);

    ref.saveInFlight = false;
    unsub();
  });

  it('does NOT add a create that fails the query.validate scope gate', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue([tabJson(ID_A, true)] as any);
    const request = new QueryRequest({
      type: Tab.type,
      scope: [],
      name: 'test:visibleTabs:reject',
      // Distinct match (adds `lane`) so this is a separate watched query from the
      // other tests — the watch key is type+query+scope, not the name.
      query: new QueryFilter({ match: { visible: true, lane: 'reject' } }),
      callback: () => {},
    });

    const unsub = await dataManager.watchQuery(request);
    const wq = watchedFor(request);
    expect(wq.results.length).toBe(1);

    vi.restoreAllMocks();
    const getSpy = vi.spyOn(apiClient, 'get');

    // A non-matching (visible:false) create must NOT appear in a visible:true query.
    fireCreate(ID_B, tabJson(ID_B, false, { lane: 'reject' }));

    expect(wq.results.length).toBe(1);
    expect(wq.results.some((e: any) => e.typeId.equals(new TypeId('tab', ID_B)))).toBe(false);
    expect(getSpy).not.toHaveBeenCalled();

    unsub();
  });

  it('does NOT duplicate an id that is already present in results', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue([tabJson(ID_A, true)] as any);
    const request = new QueryRequest({
      type: Tab.type,
      scope: [],
      name: 'test:visibleTabs:dedupe',
      // Distinct match (adds `lane`) → separate watched query from the others.
      query: new QueryFilter({ match: { visible: true, lane: 'dedupe' } }),
      callback: () => {},
    });

    const unsub = await dataManager.watchQuery(request);
    const wq = watchedFor(request);
    expect(wq.results.length).toBe(1);

    vi.restoreAllMocks();
    const getSpy = vi.spyOn(apiClient, 'get');

    // A redelivered create for the SAME id (matching the filter) must not
    // duplicate the row.
    fireCreate(ID_A, tabJson(ID_A, true, { lane: 'dedupe' }));

    expect(wq.results.length).toBe(1);
    expect(getSpy).not.toHaveBeenCalled();

    unsub();
  });

  it('a limited, ordered page: a create goes in order, the page stays its size and says it has more', async () => {
    const ids = ['a1111111-1111-4111-8111-111111111111', 'b2222222-2222-4222-8222-222222222222'];
    const page = Object.assign(
      [tabJson(ids[0], true, { lane: 'paged', created_date: '2026-10-20T00:00:00Z' }),
       tabJson(ids[1], true, { lane: 'paged', created_date: '2026-10-10T00:00:00Z' })],
      { has_more: false, next_offset: 2 },
    );
    vi.spyOn(apiClient, 'get').mockResolvedValue(page as any);
    const request = new QueryRequest({
      type: Tab.type,
      scope: [],
      query: new QueryFilter({ match: { visible: true, lane: 'paged' }, limit: 2, order_by: { created_date: 'desc' } }),
      callback: () => {},
    });
    const unsub = await dataManager.watchQuery(request);
    const wq = watchedFor(request);
    expect(wq.hasMore).toBe(false);

    // Newer than both: it goes first, and the oldest is pushed to the next page.
    fireCreate(ID_B, tabJson(ID_B, true, { lane: 'paged', created_date: '2026-10-15T00:00:00Z' }));
    expect(wq.results.map((e: any) => e.id)).toEqual([ids[0], ID_B]);
    expect(wq.hasMore).toBe(true);

    // Older than the whole page: it is on the next page, not this one.
    fireCreate(ID_A, tabJson(ID_A, true, { lane: 'paged', created_date: '2026-01-01T00:00:00Z' }));
    expect(wq.results.map((e: any) => e.id)).toEqual([ids[0], ID_B]);
    unsub();
  });

  it('a delete from a page with more behind it asks the page again, so it stays full', async () => {
    const ids = ['c3333333-3333-4333-8333-333333333333', 'd4444444-4444-4444-8444-444444444444'];
    const rowsOf = (...which: string[]) =>
      Object.assign(which.map((id) => tabJson(id, true, { lane: 'refill' })), { has_more: true, next_offset: 2 });
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue(rowsOf(ids[0], ids[1]) as any);
    const request = new QueryRequest({
      type: Tab.type,
      scope: [],
      query: new QueryFilter({ match: { visible: true, lane: 'refill' }, limit: 2 }),
      callback: () => {},
    });
    const unsub = await dataManager.watchQuery(request);
    const wq = watchedFor(request);
    expect(wq.hasMore).toBe(true);
    get.mockClear();
    get.mockResolvedValue(rowsOf(ids[1], ID_B) as any);

    (dataManager as any).onDataOp(new TypeId('tab', ids[0]).toString(), 'delete', { id: ids[0] });

    await vi.waitFor(() => expect(wq.results.map((e: any) => e.id)).toEqual([ids[1], ID_B]));
    expect(get).toHaveBeenCalledTimes(1);
    unsub();
  });

  it('a delete from a page with nothing behind it only splices', async () => {
    const id = 'e5555555-5555-4555-8555-555555555555';
    const get = vi
      .spyOn(apiClient, 'get')
      .mockResolvedValue(Object.assign([tabJson(id, true, { lane: 'last' })], { has_more: false, next_offset: 1 }) as any);
    const request = new QueryRequest({
      type: Tab.type,
      scope: [],
      query: new QueryFilter({ match: { visible: true, lane: 'last' }, limit: 2 }),
      callback: () => {},
    });
    const unsub = await dataManager.watchQuery(request);
    const wq = watchedFor(request);
    get.mockClear();
    (dataManager as any).onDataOp(new TypeId('tab', id).toString(), 'delete', { id });
    expect(wq.results).toEqual([]);
    expect(get).not.toHaveBeenCalled();
    unsub();
  });
});
