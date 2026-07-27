/**
 * Unit tests for `isBrowseListPointer` — the pure predicate that distinguishes
 * browser-only asset pointers (`list/<type>`, `folder/<…>`, project home) from
 * single-entity editor/wiki pointers. The asset route loader uses it to no-op
 * browser pointers instead of letting `AssetDocPointer.parse` throw
 * `unknown mode "list"` / `unknown mode "folder"` (the original console error).
 */
import { describe, expect, it } from 'vitest';
import { AssetMode, isBrowseListPointer } from '@src/navigation/asset-doc-types';

describe('isBrowseListPointer', () => {
  it('is true for list/<type> pointers (Skills list, etc.)', () => {
    expect(isBrowseListPointer('list/skill')).toBe(true);
    expect(isBrowseListPointer('list/all')).toBe(true);
    expect(isBrowseListPointer('list/markdown')).toBe(true);
  });

  it('is true for folder/<…> pointers', () => {
    expect(isBrowseListPointer('folder/markdown/compute_node-@local/docs')).toBe(true);
  });

  it('is true for the project-home browser surface', () => {
    expect(isBrowseListPointer(AssetMode.PROJECT_HOME)).toBe(true);
  });

  it('is false for single-entity editor/wiki pointers', () => {
    expect(isBrowseListPointer('editor/markdown/vfs/compute_node-@local/x.md')).toBe(false);
    expect(isBrowseListPointer('editor/agent/typeid/agent-d864c29b-69fc-4b8d-b748-1526a83f598a')).toBe(false);
    expect(isBrowseListPointer('wiki/@local/Some Note')).toBe(false);
  });

  it('is false for empty / unrelated pointers (no false positive on a "list" substring)', () => {
    expect(isBrowseListPointer('')).toBe(false);
    expect(isBrowseListPointer('listings/x')).toBe(false); // not the `list/` segment
    expect(isBrowseListPointer('folderish/x')).toBe(false);
  });

  it('is keyed off the AssetMode enum values, not hardcoded strings', () => {
    expect(isBrowseListPointer(`${AssetMode.LIST}/anything`)).toBe(true);
    expect(isBrowseListPointer(`${AssetMode.FOLDER}/anything`)).toBe(true);
    expect(isBrowseListPointer(AssetMode.PROJECT_HOME)).toBe(true);
    expect(isBrowseListPointer(`${AssetMode.EDITOR}/markdown/vfs/x`)).toBe(false);
  });
});
