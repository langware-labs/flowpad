/**
 * Dock-URL round-trip for the Triggers side-menu scope filter.
 *
 * The Triggers side menu carries its scope filter in the dock URL options
 * (URL-first), exactly like the Assets sidebar — read via
 * `DockPointer.scopeFilter`, written via `DockPointer.withScopeFilter`. Unlike
 * Assets, the scope must NOT split the Triggers tab: `DockPointer.tabHash` only
 * folds scope into tab identity for `ViewType.ASSETS`, so a Triggers dock stays
 * a single tab across scope changes. These tests pin both contracts.
 */

import { describe, expect, it } from 'vitest';
import { ALL_SCOPE_FILTER, type ScopeFilter } from '@src/lib/scope-filter';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';

const CASES: Array<[string, ScopeFilter]> = [
  ['all', { ...ALL_SCOPE_FILTER }],
  ['user only', { user: true, projects: [] }],
  ['current project', { user: false, projects: ['project-abc'] }],
  ['selected projects', { user: false, projects: ['project-abc', 'project-def'] }],
];

const triggersDock = () => DockPointer.forTab(ViewType.TRIGGERS);

describe('Triggers scope ⇄ dock options round-trip', () => {
  it.each(CASES)('round-trips %s through withScopeFilter / scopeFilter', (_label, scope) => {
    const back = triggersDock().withScopeFilter(scope).scopeFilter;
    expect(back).not.toBeNull();
    expect(!!back!.all).toBe(!!scope.all);
    if (!scope.all) {
      expect(back!.user).toBe(scope.user);
      expect([...back!.projects].sort()).toEqual([...scope.projects].sort());
    }
  });

  it('survives a URL serialize → parse cycle', () => {
    const dp = triggersDock().withScopeFilter({ user: false, projects: ['project-abc'] });
    const parsed = DockPointer.fromUrl(dp.toUrl());
    expect(parsed.scopeFilter?.user).toBe(false);
    expect(parsed.scopeFilter?.projects).toEqual(['project-abc']);
  });

  it('a bare Triggers dock has no scope filter (host applies its default)', () => {
    expect(triggersDock().scopeFilter).toBeNull();
  });
});

describe('Triggers stays a single tab across scope changes', () => {
  it('tabHash is identical with and without a scope filter', () => {
    const bare = triggersDock();
    const expected = `${ViewType.TRIGGERS}|`;
    expect(bare.tabHash).toBe(expected);
    for (const [, scope] of CASES) {
      expect(bare.withScopeFilter(scope).tabHash).toBe(expected);
    }
  });

  it('tabHash is identical across two different scopes', () => {
    const a = triggersDock().withScopeFilter({ ...ALL_SCOPE_FILTER }).tabHash;
    const b = triggersDock().withScopeFilter({ user: false, projects: ['project-abc'] }).tabHash;
    expect(a).toBe(b);
  });
});
