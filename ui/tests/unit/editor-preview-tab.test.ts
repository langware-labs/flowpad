import { describe, it, expect } from 'vitest';
import { openInPreview, type TabInfo } from '@src/store/use-editor-store';

const tab = (path: string, extra: Partial<TabInfo> = {}): TabInfo => ({
  path,
  isPreview: true,
  onDirtyChange: () => {},
  ...extra,
});

describe('openInPreview', () => {
  it('replaces the preview tab in place', () => {
    const prev = [tab('a', { isPreview: false }), tab('b'), tab('c', { isPreview: false })];
    expect(openInPreview(prev, tab('d')).map((t) => t.path)).toEqual(['a', 'd', 'c']);
  });

  it('appends when every open tab has been kept (edited, pinned or double-clicked)', () => {
    const prev = [tab('a', { isDirty: true, isPreview: false }), tab('b', { isPinned: true, isPreview: false })];
    expect(openInPreview(prev, tab('c')).map((t) => t.path)).toEqual(['a', 'b', 'c']);
  });

  it('is a no-op for a file that is already open', () => {
    const prev = [tab('a', { isPreview: false }), tab('b')];
    expect(openInPreview(prev, tab('a'))).toBe(prev);
  });
});
