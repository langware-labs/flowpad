/**
 * Dock-URL round-trip for a ScopeFilter.
 *
 * `scopeFilterToDockOptions` / `dockOptionsToScopeFilter` are the single home
 * for the scope-in-URL grammar (`scope-<field>`); `DockPointer.scopeFilter` /
 * `withScopeFilter` are the generic accessors every dock uses. These tests pin
 * the round-trip and the "unspecified → null" contract.
 */

import { describe, expect, it } from 'vitest';
import {
  allScope,
  dockOptionsToScopeFilter,
  filterScope,
  projectScope,
  scopeFilterEqual,
  scopeFilterToDockOptions,
  userScope,
  type ScopeFilter,
} from '@src/lib/scope-filter';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';

// A project scope's id must be a valid UUID v4/v5 — SCOPE_CODEC.decode validates
// `activeProjectId` (entity-id policy) and drops a foreign id. Filter-mode
// project ids are not validated, so plain 'p1'/'p2' are fine there.
const PA = '11111111-1111-4111-8111-111111111111';

const CASES: Array<[string, ScopeFilter]> = [
  ['all', allScope()],
  ['user only', userScope()],
  ['single project', projectScope(PA)],
  ['selected projects', filterScope(false, ['p1', 'p2'])],
  ['user + project union', filterScope(true, ['p1'])],
];

describe('scope filter ⇄ dock options round-trip', () => {
  it.each(CASES)('round-trips %s', (_label, scope) => {
    const opts = scopeFilterToDockOptions(scope);
    const back = dockOptionsToScopeFilter(opts);
    expect(back).not.toBeNull();
    expect(scopeFilterEqual(back as ScopeFilter, scope)).toBe(true);
  });

  it('encodes the mode explicitly so "all" is distinct from unspecified', () => {
    expect(scopeFilterToDockOptions(allScope())).toEqual({ 'scope-mode': 'all' });
  });

  it('returns null for options with no scope keys (unspecified → default)', () => {
    expect(dockOptionsToScopeFilter(undefined)).toBeNull();
    expect(dockOptionsToScopeFilter({})).toBeNull();
    expect(dockOptionsToScopeFilter({ pinned: 'true' })).toBeNull();
  });
});

describe('DockPointer scope facility', () => {
  it('round-trips through withScopeFilter / scopeFilter', () => {
    const scope = filterScope(false, ['p1', 'p2']);
    const dp = DockPointer.forAssetList('all').withScopeFilter(scope);
    expect(scopeFilterEqual(dp.scopeFilter as ScopeFilter, scope)).toBe(true);
  });

  it('a bare asset-list pointer has no scope filter', () => {
    expect(DockPointer.forAssetList('all').scopeFilter).toBeNull();
  });

  it('forAssetList seeds scope via the generic builder', () => {
    const dp = DockPointer.forAssetList('skill', { scope: allScope() });
    expect(dp.viewType).toBe(ViewType.ASSETS);
    expect(dp.pointer).toBe('list/skill');
    expect(scopeFilterEqual(dp.scopeFilter as ScopeFilter, allScope())).toBe(true);
  });

  it('replaces stale scope keys instead of accumulating them', () => {
    // project → all → user must end at user, with no lingering scope-* fields.
    const dp = DockPointer.forAssetList('all')
      .withScopeFilter(projectScope(PA))
      .withScopeFilter(allScope())
      .withScopeFilter(userScope());
    expect(dp.options?.['scope-activeProjectId']).toBeUndefined();
    expect(dp.options?.['scope-projects']).toBeUndefined();
    expect(scopeFilterEqual(dp.scopeFilter as ScopeFilter, userScope())).toBe(true);
  });

  it('preserves non-scope options across withScopeFilter', () => {
    const base = new DockPointer(ViewType.ASSETS, 'list/all', { pinned: 'true' });
    const dp = base.withScopeFilter(allScope());
    expect(dp.options?.pinned).toBe('true');
  });

  it('survives a URL serialize → parse cycle', () => {
    const scope = projectScope(PA);
    const dp = DockPointer.forAssetList('markdown').withScopeFilter(scope);
    const parsed = DockPointer.fromUrl(dp.toUrl());
    expect(scopeFilterEqual(parsed.scopeFilter as ScopeFilter, scope)).toBe(true);
  });
});
