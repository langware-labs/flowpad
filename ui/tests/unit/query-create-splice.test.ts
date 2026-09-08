/**
 * Regression test for X5a — the per-data-op LIST refetch on `create`.
 *
 * Bug: `onDataOp`'s `create` branch ran a full network `_query` LIST refetch
 * for every matching watched query, even though the data-op payload already
 * carries (and locally materializes) the full entity. Every incoming `create`
 * data-op therefore cost one redundant LIST GET (e.g. the triggers/cron
 * `graph/trigger` 7→15 idle climb), and this is the SHARED SDK path (tabs,
 * inbox, feed, workflows, triggers…).
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
});
