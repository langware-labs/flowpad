/**
 * Regression test for the `useEntity.ts: Error fetching entity by type ID:
 * <typeId> null` console-error flood.
 *
 * Repro: two consumers request the SAME typeId concurrently. The first drives
 * the network fetch; the second parks on `waitForTypeId` while status is
 * FETCHING. When the fetch 404s, the direct path returns null quietly and sets
 * `ref.notFound = true` WITHOUT setting `ref.error`. The OLD
 * `resolvePendingRequests` then rejected the parked waiter with `ref.error`
 * (undefined/null) — surfacing as a thrown `null` in useEntity.
 *
 * Fix: ts_sdk/src/FlowSync/store.ts — a notFound ref resolves its waiters with
 * `null` (it's "gone", not a failure), and getByTypeId honors the negative
 * cache after waiting instead of re-fetching.
 */

import { DataManager, EntityStatus, TypeId } from '@sdk';
import apiClient from '@sdk/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DataManager.resolvePendingRequests — 404 waiter handling', () => {
  it('resolves a parked waiter with null (not reject) when the ref is a 404', async () => {
    const dm = new DataManager();
    const typeId = new TypeId('user', '090ffc4d-af90-4d74-9514-aa8650abca7a');

    // Simulate the in-flight fetch having just 404'd: the direct path marks the
    // ref ERROR + notFound but never assigns ref.error.
    const ref = dm.getRef(typeId);
    ref.status = EntityStatus.ERROR;
    ref.notFound = true;

    // A concurrent consumer parked here while the fetch was FETCHING.
    // It must resolve to null, NOT reject with null.
    await expect(dm.waitForTypeId(typeId)).resolves.toBeNull();
  });

  it('still rejects a parked waiter with the real error for a non-404 failure', async () => {
    const dm = new DataManager();
    const typeId = new TypeId('user', '11111111-1111-4111-8111-111111111111');

    const boom = new Error('500 boom');
    const ref = dm.getRef(typeId);
    ref.status = EntityStatus.ERROR;
    ref.error = boom as never;

    await expect(dm.waitForTypeId(typeId)).rejects.toBe(boom);
  });

  it('rejects a reader parked on a failing (non-404) fetch with THAT error, not with nothing', async () => {
    // The real sequence behind a blank `/launch?agent=` card under StrictMode: the first
    // `useEntity` subscription drives the fetch, the second parks on it, and the hub answers 403.
    // `getByTypeId` used to mark the ref ERROR without recording the error, so the parked reader
    // was rejected with `null` and surfaced as `isError` with no error at all.
    const dm = new DataManager();
    const typeId = new TypeId('agent', '5be3d54a-3e27-4a92-bef9-cbb723e71871');
    const forbidden = Object.assign(new Error('Request failed with status code 403'), { response: { status: 403 } });
    vi.spyOn(apiClient, 'get').mockRejectedValue(forbidden);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const driver = dm.getByTypeId(typeId); // sets the ref FETCHING before its first await
    const parked = dm.getByTypeId(typeId); // parks on the in-flight fetch

    await expect(driver).rejects.toBe(forbidden);
    await expect(parked).rejects.toBe(forbidden);
  });
});
