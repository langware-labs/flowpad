import { describe, it, expect } from 'vitest';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import {
  DEFAULT_ASSET_FILTER,
  applyFilterToParams,
} from '@src/components/assets/assetFilter';

describe('DockPointer.forAssetFolder', () => {
  it('builds a pointer with typeid and relPath', () => {
    const dp = DockPointer.forAssetFolder('markdown', 'project-abc', 'docs/architecture');
    expect(dp.viewType).toBe(ViewType.ASSETS);
    expect(dp.pointer).toBe('folder/markdown/project-abc/docs/architecture');
  });

  it('strips leading and trailing slashes from relPath', () => {
    const dp = DockPointer.forAssetFolder('markdown', 'project-abc', '/docs/architecture/');
    expect(dp.pointer).toBe('folder/markdown/project-abc/docs/architecture');
  });

  it('omits the trailing slash when relPath is empty (vault root)', () => {
    const dp = DockPointer.forAssetFolder('markdown', 'project-abc', '');
    expect(dp.pointer).toBe('folder/markdown/project-abc');
  });

  it('preserves compute_node @local typeid', () => {
    const dp = DockPointer.forAssetFolder('markdown', 'compute_node-@local', 'Users/alice/.claude/docs');
    expect(dp.pointer).toBe('folder/markdown/compute_node-@local/Users/alice/.claude/docs');
  });
});

describe('DockPointer.parseAssetFolderPointer', () => {
  it('parses typeid + relPath', () => {
    const parsed = DockPointer.parseAssetFolderPointer(
      'folder/markdown/project-abc/docs/architecture',
    );
    expect(parsed).toEqual({
      typeName: 'markdown',
      typeid: 'project-abc',
      relPath: 'docs/architecture',
    });
  });

  it('parses vault-root pointer (no relPath)', () => {
    const parsed = DockPointer.parseAssetFolderPointer('folder/markdown/project-abc');
    expect(parsed).toEqual({ typeName: 'markdown', typeid: 'project-abc', relPath: '' });
  });

  it('handles compute_node-@local typeid and absolute-looking relPath', () => {
    const parsed = DockPointer.parseAssetFolderPointer(
      'folder/markdown/compute_node-@local/Users/alice/.claude/docs',
    );
    expect(parsed).toEqual({
      typeName: 'markdown',
      typeid: 'compute_node-@local',
      relPath: 'Users/alice/.claude/docs',
    });
  });

  it('returns null for non-folder pointers', () => {
    expect(DockPointer.parseAssetFolderPointer('editor/markdown/x/y')).toBeNull();
    expect(DockPointer.parseAssetFolderPointer('list/markdown')).toBeNull();
    expect(DockPointer.parseAssetFolderPointer('')).toBeNull();
    expect(DockPointer.parseAssetFolderPointer(undefined)).toBeNull();
  });

  it('returns null for malformed folder pointers (no typeid)', () => {
    expect(DockPointer.parseAssetFolderPointer('folder/markdown')).toBeNull();
  });

  it('round-trips with forAssetFolder', () => {
    const original = DockPointer.forAssetFolder(
      'markdown',
      'project-abc',
      'docs/a/b/c',
    );
    const parsed = DockPointer.parseAssetFolderPointer(original.pointer);
    expect(parsed).toEqual({
      typeName: 'markdown',
      typeid: 'project-abc',
      relPath: 'docs/a/b/c',
    });
    const rebuilt = DockPointer.forAssetFolder(
      parsed!.typeName,
      parsed!.typeid,
      parsed!.relPath,
    );
    expect(rebuilt.pointer).toBe(original.pointer);
  });

  it('round-trips a vault-root (empty relPath) pointer', () => {
    const original = DockPointer.forAssetFolder('markdown', 'compute_node-@local');
    const parsed = DockPointer.parseAssetFolderPointer(original.pointer);
    expect(parsed).toEqual({
      typeName: 'markdown',
      typeid: 'compute_node-@local',
      relPath: '',
    });
  });
});

describe('applyFilterToParams — parentPath', () => {
  it('serializes parentPath as parent_path query param', () => {
    const p = new URLSearchParams();
    applyFilterToParams(p, {
      ...DEFAULT_ASSET_FILTER,
      parentPath: '/Users/alice/docs/architecture',
    });
    expect(p.get('parent_path')).toBe('/Users/alice/docs/architecture');
  });

  it('omits parent_path when unset', () => {
    const p = new URLSearchParams();
    applyFilterToParams(p, DEFAULT_ASSET_FILTER);
    expect(p.has('parent_path')).toBe(false);
  });

  it('omits parent_path when set to empty string', () => {
    const p = new URLSearchParams();
    applyFilterToParams(p, { ...DEFAULT_ASSET_FILTER, parentPath: '' });
    expect(p.has('parent_path')).toBe(false);
  });

  it('preserves other filter serialization', () => {
    const p = new URLSearchParams();
    applyFilterToParams(p, {
      ...DEFAULT_ASSET_FILTER,
      scope: { user: true, projects: [] },
      tags: ['a', 'b'],
      parentPath: '/docs',
    });
    expect(p.get('user')).toBe('true');
    expect(p.get('projects')).toBe('');
    expect(p.get('tags')).toBe('a,b');
    expect(p.get('parent_path')).toBe('/docs');
  });
});
