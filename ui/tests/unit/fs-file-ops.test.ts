/**
 * fsFileOps — the file-manager actions decorated onto the Files and Documents
 * trees. Covers what each kind of row offers, the drop rules, free-name
 * picking, and that copy / move / paste / rename / delete reach fsManager with
 * the right paths.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fs = vi.hoisted(() => ({
  existing: new Set<string>(),
  exists: vi.fn(),
  copy: vi.fn(),
  move: vi.fn(),
  rename: vi.fn(),
  delete: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock('@sdk', async (orig) => {
  const real = await orig<typeof import('@sdk')>();
  return {
    ...real,
    fsManager: {
      exists: (_t: unknown, p: string) => {
        fs.exists(p);
        return Promise.resolve(fs.existing.has(p));
      },
      copy: (_t: unknown, a: string, b: string) => fs.copy(a, b),
      move: (_t: unknown, a: string, b: string) => fs.move(a, b),
      rename: (_t: unknown, a: string, n: string) => fs.rename(a, n),
      delete: (_t: unknown, a: string) => fs.delete(a),
      mkdir: (_t: unknown, a: string) => fs.mkdir(a),
      writeFile: (_t: unknown, a: string, c: string) => fs.writeFile(a, c),
      getDownloadUrl: (_t: unknown, a: string) => `/api/fs/download${a}`,
    },
    fsStore: { getState: () => ({ invalidate: fs.invalidate, uploadFiles: vi.fn() }) },
  };
});

import { TypeId } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import {
  __resetFsClipboardForTests,
  canDropInto,
  canPaste,
  deleteItems,
  freeName,
  fsRowDecor,
  paste,
  renameItem,
  setClipboard,
  transferItems,
  type FsOpsCtx,
} from '@src/components/browseable-tree/adapters/fsFileOps';
import type { ToolbarAction } from '@src/components/browseable-tree/types';

const TYPE = new TypeId('compute_node-@local');

function makeCtx(over: Partial<FsOpsCtx> = {}): FsOpsCtx {
  return {
    typeId: TYPE,
    locatorTypeId: TYPE,
    anchor: 'proj',
    dirNodeId: (rel) => `dir:${rel}`,
    filePointerFor: () => DockPointer.forHome(),
    machinePathFor: (rel) => `/${rel}`,
    host: {
      requestName: vi.fn(() => Promise.resolve('x.md')),
      confirm: vi.fn(() => Promise.resolve(true)),
      navigate: vi.fn(),
      onPathMoved: vi.fn(),
    },
    ...over,
  };
}

const ids = (menu: ToolbarAction[]) => menu.map((a) => a.id.split(':')[0]);
const menuOf = (d: ReturnType<typeof fsRowDecor>) =>
  typeof d.contextMenu === 'function' ? d.contextMenu() : (d.contextMenu ?? []);

beforeEach(() => {
  vi.clearAllMocks();
  fs.existing.clear();
  __resetFsClipboardForTests();
});

describe('row actions', () => {
  it('a file offers open, clipboard, rename/delete, paths and download — no create or paste', () => {
    const d = fsRowDecor(makeCtx(), { rel: 'proj/a.md', isDir: false, label: 'a.md' });
    expect(ids(menuOf(d))).toEqual([
      'open', 'cut', 'copy', 'duplicate', 'rename', 'delete', 'copy-path', 'copy-rel-path', 'reveal', 'download',
    ]);
    expect(ids(d.toolbar!)).toEqual(['rename', 'delete']);
    expect(d.onRename).toBeTypeOf('function');
    expect(d.downloadUrl).toContain('/api/fs/download/proj/a.md');
    expect(d.onDrop).toBeUndefined();
  });

  it('a folder adds create, paste, terminal and upload, and accepts drops', () => {
    const d = fsRowDecor(makeCtx(), { rel: 'proj/docs', isDir: true, label: 'docs' });
    expect(ids(menuOf(d))).toEqual([
      'new-file', 'new-folder', 'cut', 'copy', 'paste', 'duplicate', 'rename', 'delete',
      'copy-path', 'copy-rel-path', 'reveal', 'terminal', 'upload', 'download',
    ]);
    expect(ids(d.toolbar!)).toEqual(['new-file', 'new-folder', 'rename', 'delete']);
    expect(d.onDrop).toBeTypeOf('function');
    expect(d.onExternalFilesDrop).toBeTypeOf('function');
  });

  it('the top folder can receive but not be renamed, moved or deleted', () => {
    const d = fsRowDecor(makeCtx(), { rel: 'proj', isDir: true, label: 'Files' }, { isTop: true });
    expect(ids(menuOf(d))).not.toEqual(expect.arrayContaining(['rename']));
    expect(ids(menuOf(d))).not.toContain('delete');
    expect(ids(menuOf(d))).not.toContain('cut');
    expect(d.onRename).toBeUndefined();
    expect(d.selectable).toBe(false);
    expect(d.dragData).toBeUndefined();
    expect(Object.keys(d.keyActions!)).toEqual(['paste']);
  });

  it('paste is disabled until something on this entity is on the clipboard', () => {
    const ctx = makeCtx();
    const pasteItem = () =>
      menuOf(fsRowDecor(ctx, { rel: 'proj/docs', isDir: true, label: 'docs' })).find((a) => a.id.startsWith('paste'))!;
    expect((pasteItem().disabled as () => boolean)()).toBe(true);
    setClipboard(ctx, 'copy', [{ rel: 'proj/a.md', isDir: false, label: 'a.md' }]);
    expect((pasteItem().disabled as () => boolean)()).toBe(false);
    // A tree that can't reach the copied path can't paste it.
    expect(canPaste(makeCtx({ relForMachinePath: () => null }))).toBe(false);
    // A tree on another entity that maps the same disk can.
    expect(canPaste(makeCtx({ typeId: new TypeId('compute_node-d6978791-9503-5f73-a4f2-d85e581a4fff') }))).toBe(true);
  });
});

describe('drop rules', () => {
  const ctx = makeCtx();
  const drag = (rel: string, isDir = false) => ({
    kind: 'fs-ops-item',
    id: rel,
    label: rel,
    items: [{ machine: `/${rel}`, isDir, label: rel }],
  });

  it('accepts a move into another folder', () => {
    expect(canDropInto(ctx, 'proj/b', drag('proj/a/x.md'))).toBe(true);
  });
  it('refuses the folder it is already in', () => {
    expect(canDropInto(ctx, 'proj/a', drag('proj/a/x.md'))).toBe(false);
  });
  it('refuses a folder into itself or below itself', () => {
    expect(canDropInto(ctx, 'proj/a', drag('proj/a', true))).toBe(false);
    expect(canDropInto(ctx, 'proj/a/sub', drag('proj/a', true))).toBe(false);
  });
  it('refuses a path this tree cannot reach', () => {
    expect(canDropInto(makeCtx({ relForMachinePath: () => null }), 'proj/b', drag('proj/a/x.md'))).toBe(false);
  });
  it('understands the Files tree and Documents tree payloads', () => {
    expect(canDropInto(ctx, 'proj/b', { kind: 'fs-item', id: 'i', label: 'x.md', relPath: 'proj/a/x.md', isDir: false })).toBe(true);
    expect(
      canDropInto(ctx, 'proj/b', {
        kind: 'markdown-file', id: 'i', label: 'x.md', typeid: TYPE.toString(), typeName: 'markdown',
        relPath: 'ignored', absPath: '/proj/a/x.md', isDir: false,
      }),
    ).toBe(true);
  });
});

describe('operations', () => {
  it('freeName picks "copy", then "copy 2"', async () => {
    const ctx = makeCtx();
    expect(await freeName(ctx, 'proj', 'a.md')).toBe('a.md');
    fs.existing.add('/proj/a.md');
    expect(await freeName(ctx, 'proj', 'a.md')).toBe('a copy.md');
    fs.existing.add('/proj/a copy.md');
    expect(await freeName(ctx, 'proj', 'a.md')).toBe('a copy 2.md');
  });

  it('copy into the same folder takes a free name', async () => {
    fs.existing.add('/proj/a.md');
    await transferItems(makeCtx(), [{ rel: 'proj/a.md', isDir: false, label: 'a.md' }], 'proj', 'copy');
    expect(fs.copy).toHaveBeenCalledWith('/proj/a.md', '/proj/a copy.md');
  });

  it('move refuses to overwrite and reports the moved path', async () => {
    const ctx = makeCtx();
    fs.existing.add('/proj/b/x.md');
    expect(await transferItems(ctx, [{ rel: 'proj/a/x.md', isDir: false, label: 'x.md' }], 'proj/b', 'move')).toBe(0);
    expect(fs.move).not.toHaveBeenCalled();
    fs.existing.clear();
    expect(await transferItems(ctx, [{ rel: 'proj/a/x.md', isDir: false, label: 'x.md' }], 'proj/b', 'move')).toBe(1);
    expect(fs.move).toHaveBeenCalledWith('/proj/a/x.md', '/proj/b/x.md');
    expect(ctx.host.onPathMoved).toHaveBeenCalledWith('/proj/a/x.md', '/proj/b/x.md');
  });

  it('cut + paste moves once, then the clipboard is spent', async () => {
    const ctx = makeCtx();
    setClipboard(ctx, 'cut', [{ rel: 'proj/a/x.md', isDir: false, label: 'x.md' }]);
    await paste(ctx, 'proj/b');
    expect(fs.move).toHaveBeenCalledWith('/proj/a/x.md', '/proj/b/x.md');
    expect(canPaste(ctx)).toBe(false);
  });

  it('copy + paste can paste again', async () => {
    const ctx = makeCtx();
    setClipboard(ctx, 'copy', [{ rel: 'proj/a/x.md', isDir: false, label: 'x.md' }]);
    await paste(ctx, 'proj/b');
    expect(fs.copy).toHaveBeenCalledWith('/proj/a/x.md', '/proj/b/x.md');
    expect(canPaste(ctx)).toBe(true);
  });

  it('rename keeps the folder and re-points an open file', async () => {
    const ctx = makeCtx();
    await renameItem(ctx, { rel: 'proj/a/x.md', isDir: false, label: 'x.md' }, 'y.md');
    expect(fs.rename).toHaveBeenCalledWith('/proj/a/x.md', 'y.md');
    expect(ctx.host.onPathMoved).toHaveBeenCalledWith('/proj/a/x.md', '/proj/a/y.md');
  });

  it('rename refuses a slash in the name', async () => {
    await renameItem(makeCtx(), { rel: 'proj/a/x.md', isDir: false, label: 'x.md' }, 'b/y.md');
    expect(fs.rename).not.toHaveBeenCalled();
  });

  it('delete asks once for many, and never deletes the top folder', async () => {
    const ctx = makeCtx();
    await deleteItems(ctx, [
      { rel: 'proj/a.md', isDir: false, label: 'a.md' },
      { rel: 'proj/b', isDir: true, label: 'b' },
      { rel: 'proj', isDir: true, label: 'Files' },
    ]);
    expect(ctx.host.confirm).toHaveBeenCalledTimes(1);
    expect(fs.delete.mock.calls.map((c) => c[0])).toEqual(['/proj/a.md', '/proj/b']);
  });

  it('a declined delete deletes nothing', async () => {
    const ctx = makeCtx();
    (ctx.host.confirm as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    await deleteItems(ctx, [{ rel: 'proj/a.md', isDir: false, label: 'a.md' }]);
    expect(fs.delete).not.toHaveBeenCalled();
  });
});
