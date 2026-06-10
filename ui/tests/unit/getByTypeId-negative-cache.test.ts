/**
 * The dangling-context-chip 404 loop fix: a by-typeid GET that 404s must be
 * negatively cached so re-renders/re-subscribes don't re-hit the network, and
 * the 404 must be recognized by HTTP status alone (not the `{status:'FAIL'}`
 * envelope the graph 404 doesn't carry). Transient (5xx) errors must NOT be
 * negatively cached — they stay retryable.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiClient, dataManager, TypeId } from '@sdk';

function httpError(status: number) {
  // Mirrors the plain FastAPI 404 shape (axios error w/ response.status, no
  // `{status:'FAIL'}` envelope) that previously slipped past the 404 branch.
  return Object.assign(new Error(`HTTP ${status}`), { response: { status, data: {} } });
}

describe('getByTypeId negative cache', () => {
  afterEach(() => vi.restoreAllMocks());

  it('caches a plain 404 and does not re-fetch; invalidate resets', async () => {
    const typeId = new TypeId('spec', '00000000-0000-4000-8000-0000000004a1');
    dataManager.invalidateCacheByTypeId(typeId); // clean slate

    const getSpy = vi.spyOn(apiClient, 'get').mockRejectedValue(httpError(404));

    const first = await dataManager.getByTypeId(typeId);
    expect(first).toBeNull();
    expect(dataManager.isNotFound(typeId)).toBe(true);
    expect(getSpy).toHaveBeenCalledTimes(1);

    // Second call short-circuits on the negative cache — no second network hit.
    const second = await dataManager.getByTypeId(typeId);
    expect(second).toBeNull();
    expect(getSpy).toHaveBeenCalledTimes(1);

    // Invalidation drops the ref → the entity may exist again → re-fetch.
    dataManager.invalidateCacheByTypeId(typeId);
    expect(dataManager.isNotFound(typeId)).toBe(false);
    const third = await dataManager.getByTypeId(typeId);
    expect(third).toBeNull();
    expect(getSpy).toHaveBeenCalledTimes(2);
  });

  it('does not negative-cache a transient 5xx (stays retryable)', async () => {
    const typeId = new TypeId('spec', '00000000-0000-4000-8000-0000000004a2');
    dataManager.invalidateCacheByTypeId(typeId);

    const getSpy = vi.spyOn(apiClient, 'get').mockRejectedValue(httpError(500));

    await expect(dataManager.getByTypeId(typeId)).rejects.toBeTruthy();
    expect(dataManager.isNotFound(typeId)).toBe(false);

    // A retry still hits the network (no negative cache for transient errors).
    await expect(dataManager.getByTypeId(typeId)).rejects.toBeTruthy();
    expect(getSpy).toHaveBeenCalledTimes(2);
  });
});
