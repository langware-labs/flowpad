import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import {
  assetContextFolderNodeId,
  assetContextFoldersRoot,
} from '@src/components/browseable-tree/adapters/assetContextFoldersRoot';
import type { FsDragItem } from '@src/components/browseable-tree/adapters/fsFolderRoot';
import { VFSPath, TypeId, type ProjectContextDirInfo } from '@sdk';

const DIRS: ProjectContextDirInfo[] = [
  { path: '/Users/alice/notes', origin_kind: 'local' },
  { path: '/Users/alice/shared/design-docs', origin_kind: 'git' },
];

function fsDrag(relPath: string, isDir = false): FsDragItem {
  return { kind: 'fs-item', id: `fs-file:cn:${relPath}`, label: relPath.split('/').pop()!, relPath, isDir };
}

describe('DockPointer fs pointer grammar', () => {
  it('forAssetFs emits canonical VFS identity and parseAssetFsPointer round-trips', () => {
    const vfs = VFSPath.fromTypeId(new TypeId('compute_node', '@local'), '/Users/alice/notes');
    const p = DockPointer.forAssetFs(vfs);
    expect(p.viewType).toBe(ViewType.ASSETS);
    expect(p.pointer).toBe('fs/vfs/compute_node-@local/Users/alice/notes');
    expect(DockPointer.parseAssetFsPointer(p.pointer)?.equals(vfs)).toBe(true);
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
      'fs/vfs/compute_node-@local/Users/alice/notes',
      'fs/vfs/compute_node-@local/Users/alice/shared/design-docs',
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

  it('owns the same VFS resource across route types', () => {
    const root = assetContextFoldersRoot({ dirs: DIRS, onAdd: vi.fn(), onRemove: vi.fn() });
    expect(root.ownsPointer(DockPointer.forAssetFsFolder('/Users/alice/notes'))).toBe(true);
    expect(root.ownsPointer(DockPointer.forAssetList('skill'))).toBe(false);
    expect(root.ownsPointer(DockPointer.forExplorer('compute_node-@local/Users/alice/notes'))).toBe(true);
  });

  it('rows accept an fs-item drop and forward it to onDropItem', async () => {
    const onDropItem = vi.fn();
    const root = assetContextFoldersRoot({ dirs: DIRS, onAdd: vi.fn(), onRemove: vi.fn(), onDropItem });
    const rows = await root.listChildren!();
    const notes = rows[0];

    const file = fsDrag('Users/alice/project/report.md');
    expect(notes.canDrop!(file)).toBe(true);
    await notes.onDrop!(file);
    expect(onDropItem).toHaveBeenCalledWith(file, '/Users/alice/notes');

    // Foreign drag kinds are rejected.
    expect(notes.canDrop!({ kind: 'markdown-file', id: 'x', label: 'x' })).toBe(false);
    // No-op: item already directly inside the target folder.
    expect(notes.canDrop!(fsDrag('Users/alice/notes/report.md'))).toBe(false);
    // Cycle: a folder can't drop into itself or its own descendant.
    expect(notes.canDrop!(fsDrag('Users/alice/notes', true))).toBe(false);
    expect(notes.canDrop!(fsDrag('Users/alice', true))).toBe(false);

    // Without onDropItem the rows are not drop targets at all.
    const plain = await assetContextFoldersRoot({ dirs: DIRS, onAdd: vi.fn(), onRemove: vi.fn() }).listChildren!();
    expect(plain[0].canDrop).toBeUndefined();
    expect(plain[0].onDrop).toBeUndefined();
  });

  it('renders git-backed rows with the git icon and local rows with the folder icon', async () => {
    const { Folder, GitBranch } = await import('lucide-react');
    const root = assetContextFoldersRoot({ dirs: DIRS, onAdd: vi.fn(), onRemove: vi.fn() });
    const rows = await root.listChildren!();
    expect((rows[0].icon as ReactElement).type).toBe(Folder);
    expect((rows[1].icon as ReactElement).type).toBe(GitBranch);
  });

  it('rows forward external OS drops to onExternalDrop with their dir', async () => {
    const onExternalDrop = vi.fn();
    const root = assetContextFoldersRoot({ dirs: DIRS, onAdd: vi.fn(), onRemove: vi.fn(), onExternalDrop });
    const rows = await root.listChildren!();
    const entries = [{ file: new File(['x'], 'a.txt'), relPath: 'sub/a.txt' }];
    await rows[1].onExternalFilesDrop!(entries);
    expect(onExternalDrop).toHaveBeenCalledWith(entries, '/Users/alice/shared/design-docs');

    // Without onExternalDrop the rows are not external drop targets.
    const plain = await assetContextFoldersRoot({ dirs: DIRS, onAdd: vi.fn(), onRemove: vi.fn() }).listChildren!();
    expect(plain[0].onExternalFilesDrop).toBeUndefined();
  });

  it('expanded subfolder nodes are drop targets bound to their own path', async () => {
    const { TypeId } = await import('@sdk');
    const onDropItem = vi.fn();
    const root = assetContextFoldersRoot({
      dirs: DIRS,
      fsTypeId: new TypeId('compute_node', '@local'),
      onAdd: vi.fn(),
      onRemove: vi.fn(),
      onDropItem,
    });
    // Deep-link chain into a subfolder — same nodes listChildren would build.
    const chain = await root.pathFor(DockPointer.forAssetFsFolder('/Users/alice/notes/2026/plans'));
    const plans = chain[chain.length - 1];
    expect(plans.label).toBe('plans');

    const file = fsDrag('Users/alice/project/report.md');
    expect(plans.canDrop!(file)).toBe(true);
    await plans.onDrop!(file);
    // The drop lands in the exact subfolder, not the context-dir root.
    expect(onDropItem).toHaveBeenCalledWith(file, '/Users/alice/notes/2026/plans');

    // Guards still apply per subfolder (already directly inside → no-op).
    expect(plans.canDrop!(fsDrag('Users/alice/notes/2026/plans/report.md'))).toBe(false);
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
