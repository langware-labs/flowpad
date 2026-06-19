/**
 * Dock-URL round-trip for a ScopeFilter.
 *
 * `scopeFilterToDockOptions` / `dockOptionsToScopeFilter` are the single home
 * for the scope-in-URL grammar; `DockPointer.scopeFilter` / `withScopeFilter`
 * are the generic accessors every dock uses. These tests pin the round-trip and
 * the "unspecified → null" contract.
 */

import { describe, expect, it } from 'vitest';
import {
  ALL_SCOPE_FILTER,
  dockOptionsToScopeFilter,
  scopeFilterEqual,
  scopeFilterToDockOptions,
  type ScopeFilter,
} from '@src/lib/scope-filter';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';

const CASES: Array<[string, ScopeFilter]> = [
  ['all', { ...ALL_SCOPE_FILTER }],
  ['user only', { user: true, projects: [] }],
  ['single project (no user)', { user: false, projects: ['p1'] }],
  ['selected projects', { user: false, projects: ['p1', 'p2'] }],
  ['user + project union', { user: true, projects: ['p1'] }],
];

describe('scope filter ⇄ dock options round-trip', () => {
  it.each(CASES)('round-trips %s', (_label, scope) => {
    const opts = scopeFilterToDockOptions(scope);
    const back = dockOptionsToScopeFilter(opts);
    expect(back).not.toBeNull();
    expect(scopeFilterEqual(back as ScopeFilter, scope)).toBe(true);
  });

  it('encodes all explicitly so it is distinct from unspecified', () => {
    expect(scopeFilterToDockOptions({ ...ALL_SCOPE_FILTER })).toEqual({ all: 'true' });
  });

  it('returns null for options with no scope keys (unspecified → default)', () => {
    expect(dockOptionsToScopeFilter(undefined)).toBeNull();
    expect(dockOptionsToScopeFilter({})).toBeNull();
    expect(dockOptionsToScopeFilter({ pinned: 'true' })).toBeNull();
  });
});

describe('DockPointer scope facility', () => {
  it('round-trips through withScopeFilter / scopeFilter', () => {
    const scope: ScopeFilter = { user: false, projects: ['p1', 'p2'] };
    const dp = DockPointer.forAssetList('all').withScopeFilter(scope);
    expect(scopeFilterEqual(dp.scopeFilter as ScopeFilter, scope)).toBe(true);
  });

  it('a bare asset-list pointer has no scope filter', () => {
    expect(DockPointer.forAssetList('all').scopeFilter).toBeNull();
  });

  it('forAssetList seeds scope via the generic builder', () => {
    const dp = DockPointer.forAssetList('skill', { scope: { ...ALL_SCOPE_FILTER } });
    expect(dp.viewType).toBe(ViewType.ASSETS);
    expect(dp.pointer).toBe('list/skill');
    expect(scopeFilterEqual(dp.scopeFilter as ScopeFilter, ALL_SCOPE_FILTER)).toBe(true);
  });

  it('replaces stale scope keys instead of accumulating them', () => {
    // project → all → user must end at user, with no lingering all/projects.
    const dp = DockPointer.forAssetList('all')
      .withScopeFilter({ user: false, projects: ['p1'] })
      .withScopeFilter({ ...ALL_SCOPE_FILTER })
      .withScopeFilter({ user: true, projects: [] });
    expect(dp.options?.all).toBeUndefined();
    expect(scopeFilterEqual(dp.scopeFilter as ScopeFilter, { user: true, projects: [] })).toBe(true);
  });

  it('preserves non-scope options across withScopeFilter', () => {
    const base = new DockPointer(ViewType.ASSETS, 'list/all', { pinned: 'true' });
    const dp = base.withScopeFilter({ ...ALL_SCOPE_FILTER });
    expect(dp.options?.pinned).toBe('true');
  });

  it('survives a URL serialize → parse cycle', () => {
    const scope: ScopeFilter = { user: false, projects: ['abc'] };
    const dp = DockPointer.forAssetList('markdown').withScopeFilter(scope);
    const parsed = DockPointer.fromUrl(dp.toUrl());
    expect(scopeFilterEqual(parsed.scopeFilter as ScopeFilter, scope)).toBe(true);
  });
});
