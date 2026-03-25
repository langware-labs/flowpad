import { describe, it, expect } from 'vitest';
import { applyFilterToParams, DEFAULT_ASSET_FILTER } from '@src/components/assets/assetFilter';

describe('applyFilterToParams', () => {
  it('adds no scope params when scope is "all"', () => {
    const p = new URLSearchParams();
    applyFilterToParams(p, DEFAULT_ASSET_FILTER);
    expect(p.has('scope')).toBe(false);
    expect(p.has('project_ids')).toBe(false);
  });

  it('sets scope=user', () => {
    const p = new URLSearchParams();
    applyFilterToParams(p, { ...DEFAULT_ASSET_FILTER, scope: 'user' });
    expect(p.get('scope')).toBe('user');
  });

  it('sets scope=project with project_ids', () => {
    const p = new URLSearchParams();
    applyFilterToParams(p, { ...DEFAULT_ASSET_FILTER, scope: 'project', projectIds: ['a', 'b'] });
    expect(p.get('scope')).toBe('project');
    expect(p.get('project_ids')).toBe('a,b');
  });

  it('serializes tags', () => {
    const p = new URLSearchParams();
    applyFilterToParams(p, { ...DEFAULT_ASSET_FILTER, tags: ['foo', 'bar'] });
    expect(p.get('tags')).toBe('foo,bar');
  });
});
