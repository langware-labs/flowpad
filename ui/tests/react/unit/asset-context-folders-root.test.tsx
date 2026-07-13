import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import {
  assetContextFolderNodeId,
  assetContextFoldersRoot,
} from '@src/components/browseable-tree/adapters/assetContextFoldersRoot';
import type { FsDragItem } from '@src/components/browseable-tree/adapters/fsFolderRoot';
import type { ProjectContextDirInfo } from '@sdk';

const DIRS: ProjectContextDirInfo[] = [
  { path: '/Users/alice/notes', origin_kind: 'local' },
  { path: '/Users/alice/shared/design-docs', origin_kind: 'git' },
];

function fsDrag(relPath: string, isDir = false): FsDragItem {
  return { kind: 'fs-item', id: `fs-file:cn:${relPath}`, label: relPath.split('/').pop()!, relPath, isDir };
}

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
    expect(rows.map((r) => r.pointer?.pointer)).toEqual(['fs/Users/alice/notes', 'fs/Users/alice/shared/design-docs']);
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
