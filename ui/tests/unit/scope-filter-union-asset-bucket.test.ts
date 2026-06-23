/**
 * `unionAssetBucket` — the side-menu-follows-open-asset helper.
 *
 * When an asset is open in the editor whose project/scope differs from the
 * current side-menu scope, its own bucket is unioned in so its type/count
 * stays visible. The union is non-mutating, deduped, and a no-op when there's
 * nothing to add (so callers can `===`-compare to skip state churn). Any genuine
 * union yields a `filter` scope (an ad-hoc combination), driving display only.
 */

import { describe, expect, it } from 'vitest';
import {
  allScope,
  filterScope,
  scopeIncludesUser,
  scopeProjectIds,
  unionAssetBucket,
  userScope,
  type AssetScopeBucket,
} from '@src/lib/scope-filter';

describe('unionAssetBucket', () => {
  it('adds a project-scoped asset to the project list', () => {
    const out = unionAssetBucket(filterScope(false, ['A']), { projectId: 'B' });
    expect(scopeProjectIds(out)).toEqual(['A', 'B']);
    expect(scopeIncludesUser(out)).toBe(false);
  });

  it('flips user on for a user-scoped asset', () => {
    const out = unionAssetBucket(filterScope(false, ['A']), { user: true });
    expect(scopeIncludesUser(out)).toBe(true);
    expect(scopeProjectIds(out)).toEqual(['A']);
  });

  it('is a no-op (same ref) when the project is already present', () => {
    const base = filterScope(false, ['A', 'B']);
    expect(unionAssetBucket(base, { projectId: 'B' })).toBe(base);
  });

  it('is a no-op (same ref) when user is already on', () => {
    const base = userScope();
    expect(unionAssetBucket(base, { user: true })).toBe(base);
  });

  it('is a no-op (same ref) when the bucket is null', () => {
    const base = filterScope(false, ['A']);
    expect(unionAssetBucket(base, null)).toBe(base);
  });

  it('is a no-op (same ref) under "all" — already shows everything', () => {
    const base = allScope();
    expect(unionAssetBucket(base, { projectId: 'B' } as AssetScopeBucket)).toBe(base);
  });

  it('does not mutate the base filter', () => {
    const base = filterScope(false, ['A']);
    unionAssetBucket(base, { projectId: 'B' });
    expect(scopeProjectIds(base)).toEqual(['A']);
  });
});
