/**
 * dataManager.getTabName — distinguished initial tab name from a DockPointer
 * (docs/tab-management.md). entity → entity name; vfs → basename; wiki → keyword;
 * else null (chip falls back to the ViewType title).
 */
import { dataManager } from '@sdk';
import { describe, expect, it } from 'vitest';

describe('dataManager.getTabName', () => {
  it('vfs pointer → file/folder basename', () => {
    expect(dataManager.getTabName({ viewType: 'assets', pointer: 'editor/code/vfs/foo/bar/baz.ts' })).toBe('baz.ts');
  });

  it('wiki pointer → keyword', () => {
    expect(dataManager.getTabName({ viewType: 'wiki', pointer: 'wiki/space/MyConcept' })).toBe('MyConcept');
  });

  it('entity typeid not in cache → null (chip uses the ViewType title)', () => {
    const p = 'editor/markdown/typeid/markdown-00000000-0000-4000-8000-000000000000';
    expect(dataManager.getTabName({ viewType: 'assets', pointer: p })).toBeNull();
  });

  it('non-distinguished surfaces → null', () => {
    expect(dataManager.getTabName({ viewType: 'settings', pointer: 'settings' })).toBeNull();
    expect(dataManager.getTabName({ viewType: 'assets', pointer: '' })).toBeNull();
    expect(dataManager.getTabName(null)).toBeNull();
  });
});
