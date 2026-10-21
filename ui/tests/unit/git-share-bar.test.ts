import { describe, expect, it } from 'vitest';
import type { AnyEntity } from '@sdk';
import { isGitShare } from '@src/components/assets/editor/GitShareBar';

/** The bar shows only on a RECEIVED git share: its origin pins a commit. */
describe('isGitShare', () => {
  const withOrigin = (origin: unknown) => ({ origin }) as unknown as AnyEntity;

  it('a git origin pinned at a commit is a received share', () => {
    expect(isGitShare(withOrigin({ kind: 'git', head_commit: 'abc123' }))).toBe(true);
  });

  it('no pinned commit, another origin kind, or no entity is not', () => {
    expect(isGitShare(withOrigin({ kind: 'git', head_commit: null }))).toBe(false);
    expect(isGitShare(withOrigin({ kind: 'local' }))).toBe(false);
    expect(isGitShare(withOrigin(null))).toBe(false);
    expect(isGitShare(null)).toBe(false);
  });
});
