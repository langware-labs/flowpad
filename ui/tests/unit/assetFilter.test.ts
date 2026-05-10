import { describe, it, expect } from 'vitest';
import { applyFilterToParams, DEFAULT_ASSET_FILTER } from '@src/components/assets/assetFilter';

describe('applyFilterToParams', () => {
  it('scope="all" with no projectIds sends scope=user (no current project fallback)', () => {
    const p = new URLSearchParams();
    applyFilterToParams(p, DEFAULT_ASSET_FILTER);
    expect(p.get('scope')).toBe('user');
    expect(p.has('project_ids')).toBe(false);
  });

  it('scope="all" with projectIds sends scope=user,project + project_ids', () => {
    const p = new URLSearchParams();
    applyFilterToParams(p, { ...DEFAULT_ASSET_FILTER, projectIds: ['p1'] });
    expect(p.get('scope')).toBe('user,project');
    expect(p.get('project_ids')).toBe('p1');
  });

  it('sets scope=user', () => {
    const p = new URLSearchParams();
    applyFilterToParams(p, { ...DEFAULT_ASSET_FILTER, scope: 'user' });
    expect(p.get('scope')).toBe('user');
  });

  it('scope=user ignores projectIds', () => {
    const p = new URLSearchParams();
    applyFilterToParams(p, { ...DEFAULT_ASSET_FILTER, scope: 'user', projectIds: ['p1'] });
    expect(p.get('scope')).toBe('user');
    expect(p.has('project_ids')).toBe(false);
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
