/**
 * A URL that names a project is the user's decision: the asset loader opens a file of
 * ANOTHER project as a guest and never switches the active project. Without a project in
 * the URL, the file's own project still wins, as before.
 *
 * The real `loadAssetRoute`; the only stand-in is `apiClient.get` (the path lookup).
 */
import { ContextEntitiesEnum, dataContext, dataManager, TypeId } from '@sdk';
import apiClient from '@sdk/client';
import { loadAssetRoute } from '@src/routes/loaders/load-asset';
import { afterEach, describe, expect, it, vi } from 'vitest';

const DOC_ID = '1e6b1c5e-2f7a-4b8c-9d0e-1f2a3b4c5d6e';
const OTHER_PROJECT = '2a6b1c5e-2f7a-4b8c-9d0e-1f2a3b4c5d6e';
const POINTER = 'editor/markdown/vfs/compute_node-@local/w/guest/doc.md';
const DOC = {
  type: 'markdown',
  id: DOC_ID,
  asset_ref: '/w/guest/doc.md',
  project_id: OTHER_PROJECT,
  created_date: '2026-01-01T00:00:00Z',
};

afterEach(() => {
  vi.restoreAllMocks();
  dataManager.removeEntityFromCache(new TypeId('markdown', DOC_ID));
});

function stubLookup() {
  vi.spyOn(apiClient, 'get').mockImplementation(((url: string) =>
    Promise.resolve(url === '/assets/entity' ? DOC : null)) as never);
  vi.spyOn(dataContext, 'setActiveEntityTypeId').mockResolvedValue();
  return vi.spyOn(dataContext, 'setContextEntityTypeId').mockResolvedValue();
}

const projectWrites = (spy: ReturnType<typeof stubLookup>) =>
  spy.mock.calls.filter(([key]) => key === ContextEntitiesEnum.CurrentProjectTypeId);

describe('asset loader: the project named in the URL is final', () => {
  it('keeps the project when the URL names one', async () => {
    const setContext = stubLookup();
    await loadAssetRoute(POINTER, { keepProject: true });
    expect(dataContext.setActiveEntityTypeId).toHaveBeenCalledWith(new TypeId('markdown', DOC_ID));
    expect(projectWrites(setContext)).toEqual([]);
  });

  it("switches to the file's project when the URL names none", async () => {
    const setContext = stubLookup();
    await loadAssetRoute(POINTER);
    expect(projectWrites(setContext)).toEqual([
      [ContextEntitiesEnum.CurrentProjectTypeId, new TypeId('project', OTHER_PROJECT)],
    ]);
  });
});
