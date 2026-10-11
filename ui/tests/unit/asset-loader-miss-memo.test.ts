/**
 * The asset loader remembers "nothing is indexed at this path" so a revisit asks the backend
 * for nothing (dock-loading I4) — and forgets it when an asset entity is created.
 *
 * The create reaches this page as a broadcast data-op. The page did not ask for that row, so
 * the entity cache does not keep it (entity-cache-eviction.test.ts); what ends the memo is the
 * op's announcement on the app bus, not the row sitting in the cache.
 *
 * The real `loadAssetRoute`, the real store and bus; the only stand-in is `apiClient.get`.
 */
import { dataContext, dataManager, TypeId } from '@sdk';
import apiClient from '@sdk/client';
import { loadAssetRoute } from '@src/routes/loaders/load-asset';
import { afterEach, describe, expect, it, vi } from 'vitest';

const DOC_ID = '0d6b1c5e-2f7a-4b8c-9d0e-1f2a3b4c5d6e';
const POINTER = 'editor/markdown/vfs/compute_node-@local/w/p/late.md';
const DOC = { type: 'markdown', id: DOC_ID, asset_ref: '/w/p/late.md', created_date: '2026-01-01T00:00:00Z' };

afterEach(() => {
  vi.restoreAllMocks();
  dataManager.removeEntityFromCache(new TypeId('markdown', DOC_ID));
});

describe('asset loader: a remembered miss', () => {
  it('is not asked again on a revisit, and is asked again once an asset is indexed', async () => {
    let indexed = false;
    const get = vi
      .spyOn(apiClient, 'get')
      .mockImplementation(((url: string) =>
        Promise.resolve(url === '/assets/entity' && indexed ? DOC : null)) as never);
    const setActive = vi.spyOn(dataContext, 'setActiveEntityTypeId').mockResolvedValue();
    const lookups = () => get.mock.calls.filter(([url]) => url === '/assets/entity').length;

    await loadAssetRoute(POINTER);
    await loadAssetRoute(POINTER);
    expect(lookups()).toBe(1);
    expect(setActive).not.toHaveBeenCalled();

    // The indexer reaches the file: the create is broadcast to every page.
    indexed = true;
    (dataManager as unknown as { onDataOp(t: string, op: string, d: object): void }).onDataOp(
      `markdown-${DOC_ID}`,
      'create',
      DOC,
    );
    expect(dataManager.getByTypeIdFromCache(new TypeId('markdown', DOC_ID))).toBeNull();

    await loadAssetRoute(POINTER);
    expect(lookups()).toBe(2);
    expect(setActive).toHaveBeenCalledWith(new TypeId('markdown', DOC_ID));

    // A hit is warm: the next visit asks for nothing.
    await loadAssetRoute(POINTER);
    expect(lookups()).toBe(2);
  });
});
