import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TypeId } from '@sdk';
import { ViewType } from '@src/types/ViewType';
import { allScope } from '@src/lib/scope-filter';

// The tree lists through `fsStore` — stub the store, keep the rest of the SDK
// real (TypeId / VFSPath do the pointer math under test).
const { listDirectory, invalidate } = vi.hoisted(() => ({
  listDirectory: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock('@sdk', async () => {
  const actual = await vi.importActual<typeof import('@sdk')>('@sdk');
  return { ...actual, fsStore: { getState: () => ({ listDirectory, invalidate }) } };
});

const { assetsFsFolderNode, fsFileViewerPointer, fsFolderRoot } =
  await import('@src/components/browseable-tree/adapters/fsFolderRoot');

const CN = new TypeId('compute_node', '@local');
const DIR = 'Users/gadi/ws/cyber-course-1';

function fsItem(rel: string, isDir: boolean) {
  return { vfs_abs_path: `${CN.toString()}/${rel}`, name: rel.split('/').pop(), is_dir: isDir };
}

beforeEach(() => {
  listDirectory.mockReset();
  listDirectory.mockResolvedValue({
    items: [fsItem(`${DIR}/tasks`, true), fsItem(`${DIR}/Ex1.md`, false), fsItem(`${DIR}/run.py`, false)],
  });
});

describe('fsFileViewerPointer', () => {
  it('routes a markdown file to the assets markdown editor', () => {
    const p = fsFileViewerPointer(CN, `${DIR}/Ex1.md`);
    expect(p.viewType).toBe(ViewType.ASSETS);
    expect(p.pointer).toBe(`editor/markdown/vfs/${CN.toString()}/${DIR}/Ex1.md`);
  });

  it('routes a non-markdown file to the code editor', () => {
    const p = fsFileViewerPointer(CN, `${DIR}/run.py`);
    expect(p.viewType).toBe(ViewType.EDITOR);
    expect(p.pointer).toBe(`${CN.toString()}/${DIR}/run.py`);
  });
});

describe('Assets fs tree rows', () => {
  it('points FILE leaves at the file viewer, not the folder grammar', async () => {
    // Regression: file leaves used to carry `fs/<path>`, which the Assets body
    // fed to `listDirectory` as a directory — the file rendered as "Empty folder".
    const children = await assetsFsFolderNode(CN, DIR).listChildren!();
    const byLabel = new Map(children.map((c) => [c.label, c]));

    expect(byLabel.get('Ex1.md')!.pointer!.pointer).toBe(`editor/markdown/vfs/${CN.toString()}/${DIR}/Ex1.md`);
    expect(byLabel.get('run.py')!.pointer!.viewType).toBe(ViewType.EDITOR);
  });

  it('keeps FOLDER rows on the fs/ folder grammar', async () => {
    const children = await assetsFsFolderNode(CN, DIR).listChildren!();
    const tasks = children.find((c) => c.label === 'tasks')!;
    expect(tasks.pointer!.viewType).toBe(ViewType.ASSETS);
    // Folder rows carry the canonical vfs identity (`fs/vfs/<typeid>/<rel>`),
    // not a bare relative path — see DockPointer.forAssetFs.
    expect(tasks.pointer!.pointer).toBe(`fs/vfs/${CN.toString()}/${DIR}/tasks`);
  });
});

describe('Explorer fs tree rows', () => {
  it('leaves file rows on the explorer grammar (its body trims to the parent dir)', async () => {
    const root = fsFolderRoot({ typeId: CN, anchorRelPath: DIR, scope: allScope(), label: 'Computer' });
    const children = await root.listChildren!();
    const ex1 = children.find((c) => c.label === 'Ex1.md')!;
    expect(ex1.pointer!.viewType).toBe(ViewType.EXPLORER);
    expect(ex1.pointer!.pointer).toBe(`${CN.toString()}/${DIR}/Ex1.md`);
  });
});
