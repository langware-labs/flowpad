/**
 * `unionAssetBucket` — the side-menu-follows-open-asset helper.
 *
 * When an asset is open in the editor whose project/scope differs from the
 * current side-menu scope, its own bucket is unioned in so its type/count
 * stays visible. The union is non-mutating, deduped, and a no-op when there's
 * nothing to add (so callers can `===`-compare to skip state churn).
 */

import { describe, expect, it } from 'vitest';
import {
  unionAssetBucket,
  type AssetScopeBucket,
  type ScopeFilter,
} from '@src/lib/scope-filter';

describe('unionAssetBucket', () => {
  it('adds a project-scoped asset to the project list', () => {
    const base: ScopeFilter = { user: false, projects: ['A'] };
    const out = unionAssetBucket(base, { projectId: 'B' });
    expect(out.projects).toEqual(['A', 'B']);
    expect(out.user).toBe(false);
  });

  it('flips user on for a user-scoped asset', () => {
    const base: ScopeFilter = { user: false, projects: ['A'] };
    const out = unionAssetBucket(base, { user: true });
    expect(out.user).toBe(true);
    expect(out.projects).toEqual(['A']);
  });

  it('is a no-op (same ref) when the project is already present', () => {
    const base: ScopeFilter = { user: false, projects: ['A', 'B'] };
    expect(unionAssetBucket(base, { projectId: 'B' })).toBe(base);
  });

  it('is a no-op (same ref) when user is already on', () => {
    const base: ScopeFilter = { user: true, projects: [] };
    expect(unionAssetBucket(base, { user: true })).toBe(base);
  });

  it('is a no-op (same ref) when the bucket is null', () => {
    const base: ScopeFilter = { user: false, projects: ['A'] };
    expect(unionAssetBucket(base, null)).toBe(base);
  });

  it('is a no-op (same ref) under "all" — already shows everything', () => {
    const base: ScopeFilter = { user: true, projects: [], all: true };
    expect(unionAssetBucket(base, { projectId: 'B' } as AssetScopeBucket)).toBe(base);
  });

  it('does not mutate the base filter', () => {
    const base: ScopeFilter = { user: false, projects: ['A'] };
    unionAssetBucket(base, { projectId: 'B' });
    expect(base.projects).toEqual(['A']);
  });
});
