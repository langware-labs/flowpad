/**
 * Regression test for the project menu's permanent "Loading…" rows.
 *
 * Repro: consumer A fetches a typeId (ref → FETCHING); consumer B parks on
 * `waitForTypeId` against that SAME ref. Before A finishes, the ref is dropped
 * from the map (clearCache on a read-scope switch, invalidate, remove). A then
 * marks its ref READY, but the old `resolvePendingRequests` swept only refs
 * still in the map — B's promise was never settled, so `useTabProjectBuckets`'
 * `Promise.all` hung and every bucket stayed `loading`.
 *
 * Fix: ts_sdk/src/FlowSync/store.ts — the finishing request passes its own ref
 * to `resolvePendingRequests`, which settles it whether or not it is still mapped.
 */

import { DataManager, EntityStatus, TypeId } from '@sdk';
import { describe, expect, it } from 'vitest';

type Settle = { resolvePendingRequests(ownRef?: unknown): void };

describe('DataManager.resolvePendingRequests — waiter on a dropped ref', () => {
  it('settles a waiter parked on a ref that was dropped mid-fetch', async () => {
    const dm = new DataManager();
    const typeId = new TypeId('project', '3884198e-e342-4547-aafa-ccc4a0418fb6');

    const ref = dm.getRef(typeId);
    ref.status = EntityStatus.FETCHING;
    const waiter = dm.waitForTypeId(typeId);

    dm.invalidateCacheByTypeId(typeId);
    expect(dm.hasRef(typeId)).toBe(false);

    const entity = { name: 'cyber-1' } as never;
    ref.entity = entity;
    ref.status = EntityStatus.READY;
    (dm as unknown as Settle).resolvePendingRequests(ref);

    await expect(waiter).resolves.toBe(entity);
  });

  it('a map-only sweep does not reach the dropped ref', async () => {
    const dm = new DataManager();
    const typeId = new TypeId('project', '392f1677-d9ad-4bc3-99e0-78b177128f34');

    const ref = dm.getRef(typeId);
    ref.status = EntityStatus.FETCHING;
    let settled = false;
    void dm.waitForTypeId(typeId).then(() => (settled = true));

    dm.invalidateCacheByTypeId(typeId);
    ref.entity = {} as never;
    ref.status = EntityStatus.READY;
    (dm as unknown as Settle).resolvePendingRequests();
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(ref.entityPendingPromises).toHaveLength(1);
  });
});
