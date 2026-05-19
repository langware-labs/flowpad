import { describe, it, expect } from 'vitest';
import {
  applyFilterToParams,
  DEFAULT_ASSET_FILTER,
  parseScopeFilterFromParams,
  scopeFilterEqual,
  scopeFilterKey,
} from '@src/components/assets/assetFilter';

describe('applyFilterToParams (unified ScopeFilter wire format)', () => {
  it('default DEFAULT_ASSET_FILTER serializes user=true & projects=', () => {
    const p = new URLSearchParams();
    applyFilterToParams(p, DEFAULT_ASSET_FILTER);
    expect(p.get('user')).toBe('true');
    expect(p.get('projects')).toBe('');
  });

  it('user=true with projects writes both', () => {
    const p = new URLSearchParams();
    applyFilterToParams(p, { ...DEFAULT_ASSET_FILTER, scope: { user: true, projects: ['p1'] } });
    expect(p.get('user')).toBe('true');
    expect(p.get('projects')).toBe('p1');
  });

  it('user=false with projects writes user=false', () => {
    const p = new URLSearchParams();
    applyFilterToParams(p, { ...DEFAULT_ASSET_FILTER, scope: { user: false, projects: ['a', 'b'] } });
    expect(p.get('user')).toBe('false');
    expect(p.get('projects')).toBe('a,b');
  });

  it('user=false with empty projects (degenerate) still serializes both', () => {
    const p = new URLSearchParams();
    applyFilterToParams(p, { ...DEFAULT_ASSET_FILTER, scope: { user: false, projects: [] } });
    expect(p.get('user')).toBe('false');
    expect(p.get('projects')).toBe('');
  });

  it('serializes tags alongside the scope filter', () => {
    const p = new URLSearchParams();
    applyFilterToParams(p, { ...DEFAULT_ASSET_FILTER, tags: ['foo', 'bar'] });
    expect(p.get('tags')).toBe('foo,bar');
  });
});

describe('parseScopeFilterFromParams round-trip', () => {
  it('round-trips a user-only filter', () => {
    const p = new URLSearchParams();
    applyFilterToParams(p, { ...DEFAULT_ASSET_FILTER, scope: { user: true, projects: [] } });
    expect(parseScopeFilterFromParams(p)).toEqual({ user: true, projects: [] });
  });

  it('round-trips a both filter', () => {
    const p = new URLSearchParams();
    applyFilterToParams(p, { ...DEFAULT_ASSET_FILTER, scope: { user: true, projects: ['A', 'B'] } });
    expect(parseScopeFilterFromParams(p)).toEqual({ user: true, projects: ['A', 'B'] });
  });

  it('round-trips a project-only filter', () => {
    const p = new URLSearchParams();
    applyFilterToParams(p, { ...DEFAULT_ASSET_FILTER, scope: { user: false, projects: ['X'] } });
    expect(parseScopeFilterFromParams(p)).toEqual({ user: false, projects: ['X'] });
  });
});

describe('ScopeFilter helpers', () => {
  it('scopeFilterEqual is order-insensitive on projects', () => {
    expect(scopeFilterEqual({ user: true, projects: ['a', 'b'] }, { user: true, projects: ['b', 'a'] })).toBe(true);
    expect(scopeFilterEqual({ user: true, projects: ['a'] }, { user: false, projects: ['a'] })).toBe(false);
    expect(scopeFilterEqual({ user: true, projects: ['a'] }, { user: true, projects: ['b'] })).toBe(false);
  });

  it('scopeFilterKey is stable and order-insensitive', () => {
    expect(scopeFilterKey({ user: true, projects: ['b', 'a'] }))
      .toBe(scopeFilterKey({ user: true, projects: ['a', 'b'] }));
    expect(scopeFilterKey({ user: true, projects: [] })).toBe('1:');
    expect(scopeFilterKey({ user: false, projects: ['a'] })).toBe('0:a');
  });
});
