/**
 * A pending `$IN`-on-`id` batch covers its ids.
 *
 * Home measured one GET per row right after the batch that already fetched those
 * rows (5 usage_report / 12 agentic_process per-id GETs): a pending batch marked
 * nothing as in flight, so every row's `useEntity` issued its own GET in the same
 * commit. Real `dataManager`, real hooks; only the HTTP boundary is stubbed.
 */
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Conversation, QueryRequest, TypeId, dataManager } from '@sdk';
import apiClient from '@sdk/client';
import { useEntity } from '@src/hooks/entity-hooks';
import { EntityBatchHydrator } from '@src/components/entity-batch/EntityBatchHydrator';

/** Fresh ids per test: a watched query is cached by its filter, so reusing the
 *  same `$IN` list across tests would answer from the previous test's results. */
let IDS: string[] = [];
beforeEach(() => {
  IDS = [0, 1, 2].map(() => crypto.randomUUID());
});
const row = (id: string, name = `conv ${id.slice(0, 8)}`) => ({ type: 'conversation', id, name, message_ids: '[]' });

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Routes the stubbed GETs: the `$IN` list call waits on `batch`; by-id calls answer at once. */
function stubHttp(batch: Promise<unknown>) {
  const byId: string[] = [];
  const lists: string[] = [];
  vi.spyOn(apiClient, 'get').mockImplementation((async (url: string) => {
    const m = url.match(/\/conversation\/([0-9a-f-]{36})$/);
    if (m) {
      byId.push(m[1]);
      return row(m[1]);
    }
    lists.push(url);
    return batch;
  }) as never);
  return { byId, lists };
}

const batchRequest = (ids: string[]) =>
  new QueryRequest({ type: Conversation.type, query: { match: { op: '$IN', operands: ['id', ids] } }, name: 'test batch' });

afterEach(async () => {
  vi.restoreAllMocks();
  await dataManager.clearCache();
});

describe('a pending $IN batch covers its ids', () => {
  it('concurrent by-id reads wait for the batch; only an id it did not return is fetched alone', async () => {
    const batch = deferred<unknown>();
    const http = stubHttp(batch.promise);

    const query = dataManager.query(batchRequest(IDS));
    const reads = IDS.map((id) => dataManager.getByTypeId(new TypeId(Conversation.type, id)));
    batch.resolve([row(IDS[0]), row(IDS[1])]);
    const [results] = await Promise.all([query, Promise.all(reads)]);
    const entities = await Promise.all(reads);

    expect(results).toHaveLength(2);
    expect(entities.map((e) => e?.id)).toEqual(IDS);
    expect(http.byId).toEqual([IDS[2]]);
  });

  it('a failed batch releases its waiters to fetch on their own', async () => {
    const batch = deferred<unknown>();
    const http = stubHttp(batch.promise);

    const query = dataManager.query(batchRequest(IDS)).catch(() => 'failed');
    const reads = IDS.map((id) => dataManager.getByTypeId(new TypeId(Conversation.type, id)));
    batch.reject(new Error('boom'));

    expect(await query).toBe('failed');
    expect((await Promise.all(reads)).map((e) => e?.id)).toEqual(IDS);
    expect([...http.byId].sort()).toEqual([...IDS].sort());
  });

  it('an update that arrives while the batch is in flight is not lost', async () => {
    const batch = deferred<unknown>();
    stubHttp(batch.promise);
    const typeId = new TypeId(Conversation.type, IDS[0]);

    const query = dataManager.query(batchRequest([IDS[0]]));
    const read = dataManager.getByTypeId(typeId);
    (dataManager as unknown as { onDataOp: (t: string, op: string, d: object) => void }).onDataOp(
      typeId.toString(),
      'update',
      row(IDS[0], 'renamed while loading'),
    );
    batch.resolve([row(IDS[0], 'stale batch row')]);
    await query;

    expect((await read)?.name).toBe('renamed while loading');
    expect(dataManager.getByTypeIdFromCache<Conversation>(typeId)?.name).toBe('renamed while loading');
  });

  it('rows mounted before the hydrator issue no per-id GETs', async () => {
    const batch = deferred<unknown>();
    const http = stubHttp(batch.promise);

    function Row({ id }: { id: string }) {
      const { data } = useEntity<Conversation>(new TypeId(Conversation.type, id));
      return <div data-testid={`row-${id}`}>{data?.name ?? ''}</div>;
    }

    const view = render(
      <>
        {IDS.map((id) => (
          <Row key={id} id={id} />
        ))}
        <EntityBatchHydrator type={Conversation.type} ids={IDS} />
      </>,
    );
    await act(async () => {
      batch.resolve(IDS.map((id) => row(id)));
    });
    await waitFor(() => {
      for (const id of IDS) expect(view.getByTestId(`row-${id}`).textContent).toBe(`conv ${id.slice(0, 8)}`);
    });

    expect(http.byId).toEqual([]);
    expect(http.lists).toHaveLength(1);
  });
});
