import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TypeId } from '@sdk';
import { allScope } from '@src/lib/scope-filter';

/**
 * The editing capabilities `fsFolderRoot` grew so the code editor could drop
 * its own `directory-tree` implementation: dotfile filtering, a per-folder
 * toolbar, and inline rename. These replace the equivalent assertions that
 * lived in the deleted `DirectoryTree` suites.
 */
const { listDirectory, invalidate } = vi.hoisted(() => ({
  listDirectory: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock('@sdk', async () => {
  const actual = await vi.importActual<typeof import('@sdk')>('@sdk');
  return { ...actual, fsStore: { getState: () => ({ listDirectory, invalidate }) } };
});

const { fsFolderRoot } = await import('@src/components/browseable-tree/adapters/fsFolderRoot');

const CN = new TypeId('compute_node', '@local');
const ANCHOR = 'proj';

function fsItem(rel: string, isDir: boolean) {
  return { vfs_abs_path: `${CN.toString()}/${rel}`, name: rel.split('/').pop(), is_dir: isDir };
}

beforeEach(() => {
  listDirectory.mockReset();
  invalidate.mockReset();
  listDirectory.mockResolvedValue({
    items: [
      fsItem(`${ANCHOR}/.hidden-dir`, true),
      fsItem(`${ANCHOR}/src`, true),
      fsItem(`${ANCHOR}/.env`, false),
      fsItem(`${ANCHOR}/main.ts`, false),
    ],
  });
});

const base = { typeId: CN, anchorRelPath: ANCHOR, scope: allScope(), label: 'proj' };

describe('fsFolderRoot dotfile filtering', () => {
  it('lists dotfiles by default — every existing consumer relies on it', async () => {
    const rows = await fsFolderRoot({ ...base }).listChildren!();
    expect(rows.map((r) => r.label)).toEqual(['.hidden-dir', 'src', '.env', 'main.ts']);
  });

  it('hides dot-prefixed files AND folders when asked', async () => {
    const rows = await fsFolderRoot({ ...base, hideDotfiles: true }).listChildren!();
    expect(rows.map((r) => r.label)).toEqual(['src', 'main.ts']);
  });
});

describe('fsFolderRoot per-folder toolbar', () => {
  it('is absent unless the host supplies one', async () => {
    const root = fsFolderRoot({ ...base });
    expect(root.toolbar).toBeUndefined();
    const folder = (await root.listChildren!()).find((r) => r.kind === 'folder')!;
    expect(folder.toolbar).toBeUndefined();
  });

  it('reaches the root row and every folder row, carrying that folder rel path', async () => {
    const folderToolbar = vi.fn((rel: string) => [
      { id: `new:${rel}`, icon: null, label: `New in ${rel || 'root'}`, run: vi.fn() },
    ]);
    const root = fsFolderRoot({ ...base, folderToolbar });

    expect(root.toolbar?.[0].id).toBe(`new:${ANCHOR}`);

    const rows = await root.listChildren!();
    const src = rows.find((r) => r.label === 'src')!;
    expect(src.toolbar?.[0].id).toBe(`new:${ANCHOR}/src`);

    // Files are not folders — no create-here affordance on a leaf.
    expect(rows.find((r) => r.label === 'main.ts')!.toolbar).toBeUndefined();
  });
});

describe('fsFolderRoot inline rename', () => {
  it('is absent unless the host supplies a handler', async () => {
    const rows = await fsFolderRoot({ ...base }).listChildren!();
    expect(rows.every((r) => r.onRename === undefined)).toBe(true);
  });

  it('reports the rel path, the new name, and whether the row was a directory', async () => {
    const onRename = vi.fn();
    const rows = await fsFolderRoot({ ...base, onRename }).listChildren!();

    await rows.find((r) => r.label === 'main.ts')!.onRename!('renamed.ts');
    expect(onRename).toHaveBeenCalledWith(`${ANCHOR}/main.ts`, 'renamed.ts', false);

    await rows.find((r) => r.label === 'src')!.onRename!('source');
    expect(onRename).toHaveBeenCalledWith(`${ANCHOR}/src`, 'source', true);
  });
});
