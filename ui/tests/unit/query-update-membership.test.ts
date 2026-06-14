/**
 * Regression test for the match-filtered live-query membership gap.
 *
 * Bug ("tab won't close"): closing a content tab flips its `Tab.visible` to
 * false (a soft close — the row persists, ride the non-null wire rule). That
 * arrives at the SDK as a DataOp **update**, not a delete. `onDataOp` only
 * maintained watched-query membership on `create`/`delete`; an `update` that
 * pushed an entity OUT of a `match` filter left it lingering in the cached
 * query results until some unrelated refetch happened to re-run the query —
 * so the `visible:true` strip query kept the closed tab and the chip stayed
 * on screen (intermittently, depending on whether a refetch fired).
 *
 * Fix: ts_sdk/src/FlowSync/store.ts `onDataOp` — on `update`, reconcile each
 * watched query of that type: drop rows that no longer match (local splice, no
 * network); refetch only when a row newly matches (so the server applies scope).
 *
 * Narrowest reproducing layer: drive `dataManager.onDataOp` directly against a
 * real watched query — no browser, no mocks beyond the initial HTTP fetch.
 */

import { dataManager, QueryFilter, QueryRequest, Tab, TypeId } from '@sdk';
import apiClient from '@sdk/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ID = '60c389a8-5ea3-4e41-950e-4d7049099826';
const POINTER = 'lens|claude/transcript/2e10503b-491f-4989-bcf7-eb7840083e62';

function tabJson(visible: boolean, extra: object = {}) {
  return { type: 'tab', id: ID, pointer: POINTER, visible, ...extra };
}

function fireUpdate(data: object) {
  (dataManager as any).onDataOp(new TypeId('tab', ID).toString(), 'update', data);
}

function watchedFor(request: QueryRequest) {
  return (dataManager as any).watchedQueries.getWatchedQuery(request);
}

describe('DataManager: UPDATE reconciles match-filtered live-query membership', () => {
  beforeEach(async () => {
    await dataManager.clearCache();
    vi.restoreAllMocks();
  });

  afterEach(() => vi.restoreAllMocks());

  it('drops a soft-closed Tab (visible→false) from a visible:true watch, reactively, no refetch', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue([tabJson(true)] as any);
    const seen: number[] = [];
    const request = new QueryRequest({
      type: Tab.type,
      scope: [],
      name: 'test:visibleTabs',
      query: new QueryFilter({ match: { visible: true } }),
      callback: (rows: unknown[]) => seen.push(rows.length),
    });

    const unsub = await dataManager.watchQuery(request);
    const wq = watchedFor(request);
    expect(wq.results.length).toBe(1); // initial fetch delivered the visible tab

    // Restore the spy so the FIX's "drop locally" path is asserted with NO network.
    vi.restoreAllMocks();
    const getSpy = vi.spyOn(apiClient, 'get');

    // Close: the update flips visible→false (the membership-removal wire signal).
    fireUpdate(tabJson(false));

    // BUG (unfixed): the closed tab lingers in results -> chip stays on screen.
    // FIX: removed locally and the callback re-fired with the shorter list.
    expect(wq.results.length).toBe(0);
    expect(seen[seen.length - 1]).toBe(0);
    expect(getSpy).not.toHaveBeenCalled(); // removal is a local splice, never a refetch

    unsub();
  });

  it('keeps a Tab that still matches after an unrelated field update (e.g. rename)', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue([tabJson(true)] as any);
    const request = new QueryRequest({
      type: Tab.type,
      scope: [],
      name: 'test:visibleTabs:rename',
      // Distinct match (adds `pointer`) so this is a separate watched query from
      // the first test — the watch key is type+query+scope, not the name.
      query: new QueryFilter({ match: { visible: true, pointer: POINTER } }),
      callback: () => {},
    });

    const unsub = await dataManager.watchQuery(request);
    const wq = watchedFor(request);
    expect(wq.results.length).toBe(1);

    fireUpdate(tabJson(true, { name: 'Renamed' }));

    expect(wq.results.length).toBe(1); // still matches visible:true — stays
    unsub();
  });
});
