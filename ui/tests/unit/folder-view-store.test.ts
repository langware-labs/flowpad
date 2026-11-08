import { describe, expect, it } from 'vitest';
import {
  folderOf,
  sortFileItems,
  useFolderViewStore,
} from '@src/components/simple-file-manager/folderViewStore';
import type { FileItem } from '@src/components/simple-file-manager/types';

const item = (name: string, size: number, type: FileItem['type'] = 'file'): FileItem => ({
  id: name,
  name,
  type,
  size,
  modifiedAt: new Date(size),
  path: `/m/${name}`,
});

describe('folderViewStore', () => {
  it('orders like the browser: folders first, then the chosen field', () => {
    const items = [item('a.png', 30), item('sub', 0, 'folder'), item('b.png', 10)];
    expect(sortFileItems(items, { field: 'size', direction: 'asc' }).map((f) => f.name)).toEqual([
      'sub',
      'b.png',
      'a.png',
    ]);
    expect(sortFileItems(items, { field: 'name', direction: 'desc' }).map((f) => f.name)).toEqual([
      'sub',
      'b.png',
      'a.png',
    ]);
  });

  it('keys a file by its folder', () => {
    expect(folderOf('/m/x/a.png')).toBe('/m/x');
    expect(folderOf('/a.png')).toBe('/');
  });

  it('remembers sort and shown file per folder', () => {
    const { setSort, setShown } = useFolderViewStore.getState();
    setSort('/m', { field: 'size', direction: 'desc' });
    setShown('/m', 'a.png');
    expect(useFolderViewStore.getState().folders['/m']).toEqual({
      sort: { field: 'size', direction: 'desc' },
      shown: 'a.png',
    });
    expect(useFolderViewStore.getState().folders['/other']).toBeUndefined();
  });
});
