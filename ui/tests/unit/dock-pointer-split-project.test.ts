import { describe, expect, it } from 'vitest';
import { DockPointer } from '@src/navigation/DockPointer';

describe('DockPointer.splitProjectPointer', () => {
  it('returns nulls for empty/undefined/null input', () => {
    expect(DockPointer.splitProjectPointer(undefined)).toEqual({
      projectId: null,
      assetSubPointer: '',
    });
    expect(DockPointer.splitProjectPointer(null)).toEqual({
      projectId: null,
      assetSubPointer: '',
    });
    expect(DockPointer.splitProjectPointer('')).toEqual({
      projectId: null,
      assetSubPointer: '',
    });
  });

  it('parses a bare projectId with no sub-pointer', () => {
    const pid = 'dd682350-c185-52c9-a92b-d0667141b069';
    expect(DockPointer.splitProjectPointer(pid)).toEqual({
      projectId: pid,
      assetSubPointer: '',
    });
  });

  it('splits projectId from a single-segment sub-pointer', () => {
    const pid = 'dd682350-c185-52c9-a92b-d0667141b069';
    expect(DockPointer.splitProjectPointer(`${pid}/editor`)).toEqual({
      projectId: pid,
      assetSubPointer: 'editor',
    });
  });

  it('preserves multi-segment sub-pointers (folders, editor with typeid)', () => {
    const pid = 'dd682350-c185-52c9-a92b-d0667141b069';
    expect(
      DockPointer.splitProjectPointer(`${pid}/editor/markdown-abc123`),
    ).toEqual({
      projectId: pid,
      assetSubPointer: 'editor/markdown-abc123',
    });
    expect(
      DockPointer.splitProjectPointer(`${pid}/folder/markdown-vault1/notes/sub`),
    ).toEqual({
      projectId: pid,
      assetSubPointer: 'folder/markdown-vault1/notes/sub',
    });
  });
});
