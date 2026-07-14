import { describe, expect, it } from 'vitest';
import { TypeId } from '@sdk';
import { buildRowDragItem } from '@src/components/simple-file-manager/drag-payload';
import { fsDragEntries } from '@src/components/browseable-tree/adapters/fsFolderRoot';
import type { FileItem } from '@src/components/simple-file-manager/types';

const CN = new TypeId('compute_node', '@local');

function file(path: string, type: 'file' | 'folder' = 'file'): FileItem {
  const name = path.split('/').pop()!;
  return { id: path.replace(/^\/+/, ''), name, type, size: 0, modifiedAt: new Date(0), path };
}

const A = file('/Users/alice/proj/a.txt');
const B = file('/Users/alice/proj/b.txt');
const DIR = file('/Users/alice/proj/sub', 'folder');

describe('buildRowDragItem', () => {
  it('single row (not part of a multi-selection) → single-entry payload', () => {
    const item = buildRowDragItem(A, new Set(), [A, B, DIR], CN);
    expect(item.kind).toBe('fs-item');
    expect(item.relPath).toBe('Users/alice/proj/a.txt');
    expect(item.isDir).toBe(false);
    expect(item.items).toBeUndefined();
    expect(fsDragEntries(item)).toEqual([{ relPath: 'Users/alice/proj/a.txt', isDir: false, label: 'a.txt' }]);
  });

  it('dragging a selected row carries the WHOLE selection', () => {
    const selected = new Set([A.id, B.id, DIR.id]);
    const item = buildRowDragItem(B, selected, [A, B, DIR], CN);
    expect(item.relPath).toBe('Users/alice/proj/b.txt');
    expect(fsDragEntries(item)).toEqual([
      { relPath: 'Users/alice/proj/a.txt', isDir: false, label: 'a.txt' },
      { relPath: 'Users/alice/proj/b.txt', isDir: false, label: 'b.txt' },
      { relPath: 'Users/alice/proj/sub', isDir: true, label: 'sub' },
    ]);
  });

  it('multi-payload survives the dataTransfer JSON round-trip', () => {
    const selected = new Set([A.id, DIR.id]);
    const item = buildRowDragItem(A, selected, [A, B, DIR], CN);
    const roundTripped = JSON.parse(JSON.stringify(item));
    expect(fsDragEntries(roundTripped)).toHaveLength(2);
  });

  it('dragging an UNSELECTED row while others are selected drags only that row', () => {
    const selected = new Set([A.id, B.id]);
    const item = buildRowDragItem(DIR, selected, [A, B, DIR], CN);
    expect(item.isDir).toBe(true);
    expect(item.items).toBeUndefined();
    expect(fsDragEntries(item)).toEqual([{ relPath: 'Users/alice/proj/sub', isDir: true, label: 'sub' }]);
  });
});
