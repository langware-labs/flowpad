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
import {
  allScope,
  filterScope,
  isAllScope,
  projectScope,
  scopeIncludesUser,
  scopeProjectIds,
  userScope,
  type ScopeFilter,
} from '@src/lib/scope-filter';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';

// Project/filter scopes only survive a dock-URL round-trip when their ids are
// valid entity ids (UUID v4/v5) — `SCOPE_CODEC.decode` drops a foreign id. Use
// real UUIDs so the round-trip preserves the project ids.
const PROJECT_ABC = '00000000-0000-4000-8000-000000000abc';
const PROJECT_DEF = '00000000-0000-4000-8000-000000000def';

const CASES: Array<[string, ScopeFilter]> = [
  ['all', allScope()],
  ['user only', userScope()],
  ['current project', projectScope(PROJECT_ABC)],
  ['selected projects', filterScope(false, [PROJECT_ABC, PROJECT_DEF])],
];

const triggersDock = () => DockPointer.forTab(ViewType.TRIGGERS);

describe('Triggers scope ⇄ dock options round-trip', () => {
  it.each(CASES)('round-trips %s through withScopeFilter / scopeFilter', (_label, scope) => {
    const back = triggersDock().withScopeFilter(scope).scopeFilter;
    expect(back).not.toBeNull();
    expect(isAllScope(back!)).toBe(isAllScope(scope));
    if (!isAllScope(scope)) {
      expect(scopeIncludesUser(back!)).toBe(scopeIncludesUser(scope));
      expect([...scopeProjectIds(back!)].sort()).toEqual([...scopeProjectIds(scope)].sort());
    }
  });

  it('survives a URL serialize → parse cycle', () => {
    const dp = triggersDock().withScopeFilter(projectScope(PROJECT_ABC));
    const parsed = DockPointer.fromUrl(dp.toUrl());
    expect(parsed.scopeFilter?.mode).toBe('project');
    expect(scopeProjectIds(parsed.scopeFilter!)).toEqual([PROJECT_ABC]);
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
    const a = triggersDock().withScopeFilter(allScope()).tabHash;
    const b = triggersDock().withScopeFilter(projectScope(PROJECT_ABC)).tabHash;
    expect(a).toBe(b);
  });
});
