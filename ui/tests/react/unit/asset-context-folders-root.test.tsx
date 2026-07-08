import { describe, expect, it, vi } from 'vitest';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import {
  assetContextFolderNodeId,
  assetContextFoldersRoot,
} from '@src/components/browseable-tree/adapters/assetContextFoldersRoot';

const DIRS = ['/Users/alice/notes', '/Users/alice/shared/design-docs'];

describe('DockPointer fs pointer grammar', () => {
  it('forAssetFsFolder normalizes and parseAssetFsPointer round-trips', () => {
    const p = DockPointer.forAssetFsFolder('/Users/alice/notes/');
    expect(p.viewType).toBe(ViewType.ASSETS);
    expect(p.pointer).toBe('fs/Users/alice/notes');
    expect(DockPointer.parseAssetFsPointer(p.pointer)).toBe('Users/alice/notes');
  });

  it('parseAssetFsPointer rejects non-fs pointers', () => {
    expect(DockPointer.parseAssetFsPointer('list/skill')).toBeNull();
    expect(DockPointer.parseAssetFsPointer(undefined)).toBeNull();
  });
});

describe('assetContextFoldersRoot', () => {
  it('lists one row per dir addressing the assets fs pointer', async () => {
    const root = assetContextFoldersRoot({ dirs: DIRS, onAdd: vi.fn(), onRemove: vi.fn() });
    const rows = await root.listChildren!();
    expect(rows.map((r) => r.label)).toEqual(['notes', 'design-docs']);
    expect(rows.map((r) => r.pointer?.pointer)).toEqual([
      'fs/Users/alice/notes',
      'fs/Users/alice/shared/design-docs',
    ]);
    expect(rows.every((r) => r.pointer?.viewType === ViewType.ASSETS)).toBe(true);
  });

  it('exposes add on the root toolbar and remove per row', async () => {
    const onAdd = vi.fn();
    const onRemove = vi.fn();
    const root = assetContextFoldersRoot({ dirs: DIRS, onAdd, onRemove });
    await root.toolbar![0].run();
    expect(onAdd).toHaveBeenCalledOnce();
    const rows = await root.listChildren!();
    await rows[1].toolbar![0].run();
    expect(onRemove).toHaveBeenCalledWith('/Users/alice/shared/design-docs');
  });

  it('owns only assets fs/ pointers', () => {
    const root = assetContextFoldersRoot({ dirs: DIRS, onAdd: vi.fn(), onRemove: vi.fn() });
    expect(root.ownsPointer(DockPointer.forAssetFsFolder('/Users/alice/notes'))).toBe(true);
    expect(root.ownsPointer(DockPointer.forAssetList('skill'))).toBe(false);
    expect(root.ownsPointer(DockPointer.forExplorer('compute_node-@local/Users/alice/notes'))).toBe(false);
  });

  it('pathFor resolves a subfolder pointer to its owning context-dir row', async () => {
    const root = assetContextFoldersRoot({ dirs: DIRS, onAdd: vi.fn(), onRemove: vi.fn() });
    const chain = await root.pathFor(DockPointer.forAssetFsFolder('/Users/alice/notes/2026/plans'));
    expect(chain.map((n) => n.id)).toEqual([
      'asset-context-folders-root',
      assetContextFolderNodeId('/Users/alice/notes'),
    ]);
    // A path under no context dir resolves to just the root.
    const miss = await root.pathFor(DockPointer.forAssetFsFolder('/tmp/elsewhere'));
    expect(miss.map((n) => n.id)).toEqual(['asset-context-folders-root']);
  });
});
