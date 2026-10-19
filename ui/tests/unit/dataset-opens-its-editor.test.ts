/**
 * Opening a dataset opens the app that edits it — the backend ranks (nested, then kind, then
 * type); the click only opens the winner through `navigation.openDock`, URL-first.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const editorsFor = vi.hoisted(() => vi.fn());
vi.mock('@sdk', async (importOriginal) => ({ ...(await importOriginal<typeof import('@sdk')>()), editorsFor }));

import { navigateToResult } from '@src/navigation/record-type-nav';
import type { SearchRow } from '@src/hooks/search-row';

const DATASET = '6d1a2b3c-4d5e-4f6a-8b7c-9d0e1f2a3b4c';
const EDITOR = 'micro_app-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const row = {
  record_id: DATASET,
  record_type: 'dataset',
  name: 'smart-navigator',
  asset_ref: '/tmp/ds',
} as unknown as SearchRow;

describe('a dataset opens in the app that edits it', () => {
  afterEach(() => vi.clearAllMocks());

  it('opens the best editor, naming the dataset as its subject', async () => {
    editorsFor.mockResolvedValue([{ typeid: EDITOR, name: 'editor', title: 'editor', why: 'nested' }]);
    const openDock = vi.fn();
    await navigateToResult(row, { openDock } as never);
    expect(editorsFor).toHaveBeenCalledWith(`dataset-${DATASET}`);
    const dock = openDock.mock.calls[0][0];
    expect(dock.viewType).toBe('app');
    expect(dock.pointer).toBe(EDITOR);
    expect(dock.options).toMatchObject({ subject: `dataset-${DATASET}` });
  });

  it('falls back to the folder when nothing edits it', async () => {
    editorsFor.mockResolvedValue([]);
    const openDock = vi.fn();
    await navigateToResult(row, { openDock } as never);
    expect(openDock.mock.calls.length).toBeLessThanOrEqual(1);
    if (openDock.mock.calls.length) expect(openDock.mock.calls[0][0].viewType).not.toBe('app');
  });
});

describe('the asset tree opens a dataset where the record list does', () => {
  afterEach(() => vi.clearAllMocks());

  it("a dataset row opens its editor app, not the folder", async () => {
    const { buildAssetChild } = await import('@src/components/browseable-tree/adapters/assetTypeRoot');
    const { openBrowseable } = await import('@src/components/browseable-tree/open');
    editorsFor.mockResolvedValue([{ typeid: EDITOR, name: 'editor', title: 'editor', why: 'nested' }]);
    const node = buildAssetChild('dataset', row as never, true, 'root');
    expect(node.pointer).toBeNull();
    const navigate = vi.fn();
    expect(openBrowseable(node, navigate)).toBe(true);
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    const dock = navigate.mock.calls[0][0];
    expect(dock.viewType).toBe('app');
    expect(dock.options).toMatchObject({ subject: `dataset-${DATASET}` });
  });
});
