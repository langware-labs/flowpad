/**
 * A live query that holds its OWN copy of a row still sees that row's updates.
 *
 * Bug (2026-10-06, live sessions): the guest's conversation listed its session
 * as "awaiting approval" forever after the host approved — the backend row was
 * idle and the update reached the page, but the conversation's sessions query
 * held a different instance of the row than the entity cache. `onDataOp`
 * merged the update into the cache's instance only (and re-notified the query,
 * which re-rendered its stale copy).
 *
 * Fix: ts_sdk/src/FlowSync/store.ts `onDataOp` — on an update to a row already
 * in a matching query's results, merge into the row the query holds when it is
 * not the cached instance. Driven through `onDataOp` against a real watched query.
 */

import { dataManager, QueryFilter, QueryRequest, RemoteWorkerSession, TypeId } from '@sdk';
import apiClient from '@sdk/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ID = '5d52e5cb-a87f-4bd5-ad1e-32ee4d202dda';
const CONV = '0d87a477-3202-4470-9a64-74e7c01e9324';
const row = (status: string) => ({ type: 'remote_worker_session', id: ID, conversation_id: CONV, status });

describe('DataManager: an update reaches a query that holds its own copy of the row', () => {
  beforeEach(async () => {
    await dataManager.clearCache();
    vi.restoreAllMocks();
  });
  afterEach(() => vi.restoreAllMocks());

  it('the query re-renders the updated status, not its stale copy', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue([row('pending')] as any);
    const seen: string[] = [];
    const request = new QueryRequest({
      type: RemoteWorkerSession.type,
      scope: [],
      name: 'test:conversationSessions',
      query: new QueryFilter({ match: { conversation_id: CONV } }),
      callback: (rows: unknown[]) => seen.push(String((rows[0] as RemoteWorkerSession | undefined)?.status)),
    });
    const unsub = await dataManager.watchQuery(request);
    const wq = (dataManager as any).watchedQueries.getWatchedQuery(request);

    // The cache holds a DIFFERENT instance of the same row (as when another view fetched it).
    const typeId = new TypeId(RemoteWorkerSession.type, ID);
    const other = new RemoteWorkerSession(row('pending') as never);
    const ref = (dataManager as any).entities.get(typeId);
    if (ref) ref.entity = other;
    else (dataManager as any).register_new_entity(typeId, other);
    expect(wq.results[0]).not.toBe(other);

    (dataManager as any).onDataOp(typeId.toString(), 'update', row('idle'));

    expect(wq.results[0].status).toBe('idle');
    expect(seen[seen.length - 1]).toBe('idle');
    unsub();
  });
});
