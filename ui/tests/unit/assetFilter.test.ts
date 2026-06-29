import { describe, it, expect } from 'vitest';
import {
  applyFilterToParams,
  DEFAULT_ASSET_FILTER,
} from '@src/components/assets/assetFilter';
import {
  filterScope,
  projectScope,
  userScope,
  scopeFilterEqual,
  scopeFilterKey,
} from '@src/lib/scope-filter';

describe('applyFilterToParams (unified ScopeFilter wire format)', () => {
  it('default DEFAULT_ASSET_FILTER serializes user=true & projects=', () => {
    const p = new URLSearchParams();
    applyFilterToParams(p, DEFAULT_ASSET_FILTER);
    expect(p.get('user')).toBe('true');
    expect(p.get('projects')).toBe('');
  });

  it('user=true with projects writes both', () => {
    const p = new URLSearchParams();
    applyFilterToParams(p, { ...DEFAULT_ASSET_FILTER, scope: filterScope(true, ['p1']) });
    expect(p.get('user')).toBe('true');
    expect(p.get('projects')).toBe('p1');
  });

  it('user=false with projects writes user=false', () => {
    const p = new URLSearchParams();
    applyFilterToParams(p, { ...DEFAULT_ASSET_FILTER, scope: filterScope(false, ['a', 'b']) });
    expect(p.get('user')).toBe('false');
    expect(p.get('projects')).toBe('a,b');
  });

  it('user=false with empty projects (degenerate) still serializes both', () => {
    const p = new URLSearchParams();
    applyFilterToParams(p, { ...DEFAULT_ASSET_FILTER, scope: filterScope(false, []) });
    expect(p.get('user')).toBe('false');
    expect(p.get('projects')).toBe('');
  });

  it('serializes tags alongside the scope filter', () => {
    const p = new URLSearchParams();
    applyFilterToParams(p, { ...DEFAULT_ASSET_FILTER, tags: ['foo', 'bar'] });
    expect(p.get('tags')).toBe('foo,bar');
  });
});

describe('ScopeFilter helpers', () => {
  it('scopeFilterEqual is order-insensitive on projects', () => {
    expect(scopeFilterEqual(filterScope(true, ['a', 'b']), filterScope(true, ['b', 'a']))).toBe(true);
    expect(scopeFilterEqual(filterScope(true, ['a']), filterScope(false, ['a']))).toBe(false);
    expect(scopeFilterEqual(filterScope(true, ['a']), filterScope(true, ['b']))).toBe(false);
  });

  it('scopeFilterKey is stable and order-insensitive', () => {
    expect(scopeFilterKey(filterScope(true, ['b', 'a'])))
      .toBe(scopeFilterKey(filterScope(true, ['a', 'b'])));
    expect(scopeFilterKey(filterScope(true, ['a', 'b']))).toBe('filter:1:a,b');
    expect(scopeFilterKey(userScope())).toBe('user');
    expect(scopeFilterKey(projectScope('a'))).toBe('project:a');
  });
});
