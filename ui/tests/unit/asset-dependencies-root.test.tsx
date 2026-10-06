import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import {
  assetContextFolderNodeId,
  assetContextFoldersRoot,
} from '@src/components/browseable-tree/adapters/assetContextFoldersRoot';
import type { FsDragItem } from '@src/components/browseable-tree/adapters/fsFolderRoot';
import { render, screen } from '@testing-library/react';
import { TooltipProvider } from '@src/components/ui/tooltip';
import { VFSPath, TypeId, type DependencyState, type ProjectContextDirInfo } from '@sdk';

const DIRS: ProjectContextDirInfo[] = [
  { path: '/Users/alice/notes', origin_kind: 'local', dependency: 'notes', required: true, via: '' },
  { path: '/Users/alice/shared/design-docs', origin_kind: 'git', dependency: 'design-docs', required: true, via: '' },
];

function dep(name: string, extra: Partial<DependencyState> = {}): DependencyState {
  return {
    name,
    source: `file:/Users/alice/${name}`,
    required: true,
    path: '.',
    state: 'ready',
    local_path: null,
    reason: null,
    via: null,
    dismissed: false,
    ...extra,
  };
}

const DEPS: DependencyState[] = [
  dep('notes', { local_path: '/Users/alice/notes' }),
  dep('design-docs', { source: 'git+https://github.com/alice/design-docs#main', local_path: '/Users/alice/shared/design-docs' }),
  dep('vendor-docs', { required: false, state: 'not_installed', source: 'hub:00000000-0000-4000-8000-0000000000aa' }),
  dep('api-specs', { state: 'unreachable', reason: 'Repository not found', source: 'git+https://github.com/acme/specs' }),
  // An optional one whose install failed: the backend reports the failure state.
  dep('extras', { required: false, state: 'unreachable', reason: 'Hub project not reachable', source: 'hub:00000000-0000-4000-8000-0000000000bb' }),
];

/** Render a row's badge (state + kind chips) so its chips can be queried. */
function renderBadge(badge: unknown) {
  return render(<TooltipProvider>{badge as ReactElement}</TooltipProvider>);
}

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
  it('is labelled Dependencies', () => {
    const root = assetContextFoldersRoot({ dirs: [], onAdd: vi.fn(), onRemove: vi.fn() });
    expect(root.label).toBe('Dependencies');
    expect(root.toolbar![0].label).toBe('Add dependency');
  });

  it('lists every declared dependency, with or without a folder here', async () => {
    const root = assetContextFoldersRoot({ dirs: DIRS, dependencies: DEPS, onAdd: vi.fn(), onRemove: vi.fn() });
    expect(root.hasChildren).toBe(true);
    const rows = await root.listChildren!();
    expect(rows.map((r) => r.label)).toEqual(['notes', 'design-docs', 'vendor-docs', 'api-specs', 'extras']);
    // The resolved ones browse their folder; the absent ones only report.
    expect(rows[0].pointer?.pointer).toBe('fs/vfs/compute_node-@local/Users/alice/notes');
    expect(rows[2].pointer).toBeNull();
    expect(rows[3].pointer).toBeNull();
    expect(rows[2].hasChildren).toBe(false);
  });

  it('lists the declared dependencies even when nothing resolved yet', () => {
    const root = assetContextFoldersRoot({ dirs: [], dependencies: [DEPS[2]], onAdd: vi.fn(), onRemove: vi.fn() });
    expect(root.hasChildren).toBe(true);
  });

  it('marks each row with a state dot only, so the name keeps the width', async () => {
    const root = assetContextFoldersRoot({ dirs: DIRS, dependencies: DEPS, onAdd: vi.fn(), onRemove: vi.fn() });
    const rows = await root.listChildren!();
    const states = rows.map((r) => {
      const view = renderBadge(r.badge);
      const dot = view.getByTestId('dependency-state');
      const row = [dot.getAttribute('data-state'), dot.getAttribute('data-required')];
      // No chips in the tree: they squeezed the name to a letter.
      expect(view.queryByTestId('dependency-kind')).toBeNull();
      view.unmount();
      return row;
    });
    expect(states).toEqual([
      ['ready', 'true'],
      ['ready', 'true'],
      ['not_installed', 'false'],
      ['unreachable', 'true'],
      ['unreachable', 'false'],
    ]);
  });

  it('says the state and whether it is required or optional in the row tooltip', async () => {
    const root = assetContextFoldersRoot({ dirs: DIRS, dependencies: DEPS, onAdd: vi.fn(), onRemove: vi.fn() });
    const rows = await root.listChildren!();
    const view = render(<>{rows[2].tooltip}</>);
    expect(view.getByTestId('dependency-tooltip-state').textContent).toBe('not installed · optional');
    view.unmount();
    render(<>{rows[0].tooltip}</>);
    expect(screen.getByTestId('dependency-tooltip-state').textContent).toBe('ready · required');
  });

  it('offers Install on an optional dependency that is not here, including a failed install', async () => {
    const onInstall = vi.fn();
    const root = assetContextFoldersRoot({
      dirs: DIRS,
      dependencies: DEPS,
      onAdd: vi.fn(),
      onRemove: vi.fn(),
      onInstall,
    });
    const rows = await root.listChildren!();
    const ids = rows.map((r) => (r.toolbar ?? []).map((a) => a.id));
    expect(ids).toEqual([['remove'], ['remove'], ['install', 'remove'], ['remove'], ['install', 'remove']]);
    await rows[2].toolbar![0].run();
    expect(onInstall).toHaveBeenCalledWith('vendor-docs');
    await rows[4].toolbar![0].run();
    expect(onInstall).toHaveBeenCalledWith('extras');
  });

  it('removes a dependency by its name, passing its folder when it has one', async () => {
    const onRemove = vi.fn();
    const root = assetContextFoldersRoot({ dirs: DIRS, dependencies: DEPS, onAdd: vi.fn(), onRemove });
    const rows = await root.listChildren!();
    expect(rows[1].toolbar![0].label).toBe('Remove dependency');
    await rows[1].toolbar![0].run();
    expect(onRemove).toHaveBeenCalledWith('design-docs', '/Users/alice/shared/design-docs');
    await rows[3].toolbar![0].run();
    expect(onRemove).toHaveBeenCalledWith('api-specs', null);
  });

  it('never offers to remove a dependency another dependency declared', async () => {
    const transitive = dep('inner', { via: 'notes', state: 'missing' });
    const root = assetContextFoldersRoot({ dirs: [], dependencies: [transitive], onAdd: vi.fn(), onRemove: vi.fn() });
    const [row] = await root.listChildren!();
    expect(row.toolbar).toBeUndefined();
  });

  it('carries the reason a dependency is not ready on its tooltip', async () => {
    const root = assetContextFoldersRoot({ dirs: DIRS, dependencies: DEPS, onAdd: vi.fn(), onRemove: vi.fn() });
    const rows = await root.listChildren!();
    render(<>{rows[3].tooltip}</>);
    expect(screen.getByText('Repository not found')).toBeTruthy();
  });

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

  it('exposes add on the root toolbar; a folder no dependency claims has nothing to remove', async () => {
    const onAdd = vi.fn();
    const root = assetContextFoldersRoot({ dirs: DIRS, onAdd, onRemove: vi.fn() });
    await root.toolbar![0].run();
    expect(onAdd).toHaveBeenCalledOnce();
    const rows = await root.listChildren!();
    expect(rows[1].toolbar).toBeUndefined();
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
    const { RagFolderIcon } = await import('@src/components/browseable-tree/RagFolderIcon');
    const root = assetContextFoldersRoot({ dirs: DIRS, onAdd: vi.fn(), onRemove: vi.fn() });
    const rows = await root.listChildren!();
    // The row icon is the RAG badge WRAPPING the base glyph — the folder's
    // index state is drawn over it — so the base is a prop now, not the
    // element type. Assert through the wrapper rather than around it: the
    // question this test exists to answer is still "git rows get GitBranch".
    expect((rows[0].icon as ReactElement).type).toBe(RagFolderIcon);
    expect((rows[0].icon as ReactElement).props.Base).toBe(Folder);
    expect((rows[1].icon as ReactElement).type).toBe(RagFolderIcon);
    expect((rows[1].icon as ReactElement).props.Base).toBe(GitBranch);
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
    // The drop lands in the exact subfolder, not the dependency root.
    expect(onDropItem).toHaveBeenCalledWith(file, '/Users/alice/notes/2026/plans');

    // Guards still apply per subfolder (already directly inside → no-op).
    expect(plans.canDrop!(fsDrag('Users/alice/notes/2026/plans/report.md'))).toBe(false);
  });

  it('pathFor resolves a subfolder pointer to its owning dependency row', async () => {
    const root = assetContextFoldersRoot({ dirs: DIRS, onAdd: vi.fn(), onRemove: vi.fn() });
    const chain = await root.pathFor(DockPointer.forAssetFsFolder('/Users/alice/notes/2026/plans'));
    expect(chain.map((n) => n.id)).toEqual([
      'asset-context-folders-root',
      assetContextFolderNodeId('/Users/alice/notes'),
    ]);
    // A path under no dependency dir resolves to just the root.
    const miss = await root.pathFor(DockPointer.forAssetFsFolder('/tmp/elsewhere'));
    expect(miss.map((n) => n.id)).toEqual(['asset-context-folders-root']);
  });
});
