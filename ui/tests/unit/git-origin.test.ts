import { describe, expect, it } from 'vitest';
import {
  formatGitOrigin,
  gitOriginOf,
  gitOriginRepoFullName,
  isCompleteGitOrigin,
  isSafeRelPath,
  type GitOrigin,
} from '@sdk';

// FE mirror of the backend git-origin contract (flow_sdk/builtin/git_origin.py
// + tests/unit/test_git_origin_placement.py). FE and BE MUST agree on what a
// safe repo-relative path is and how provenance is read off a received entity.

const ORIGIN: GitOrigin = {
  provider: 'github',
  owner: 'Acme',
  name: 'Widgets',
  branch: 'feature/x',
  head_commit: 'a'.repeat(40),
  rel_path: 'packages/x/.claude/skills/foo',
};

describe('isSafeRelPath — agrees with backend is_safe_rel_path', () => {
  // Same accept/reject cases as the Python parametrized tests.
  it.each(['docs/foo.md', 'packages/x/.claude/skills/foo', '.claude/skills/foo'])(
    'accepts relative path %s',
    (p) => expect(isSafeRelPath(p)).toBe(true),
  );

  it.each(['', '   ', '/abs/path', 'C:/win', '../escape', 'a/../../b', 'a/../b'])(
    'rejects unsafe path %s',
    (p) => expect(isSafeRelPath(p)).toBe(false),
  );

  it('rejects backslash-escaped traversal', () => {
    expect(isSafeRelPath('a\\..\\b')).toBe(false);
  });
});

describe('formatGitOrigin / repo full name', () => {
  it('renders owner/name · branch — rel_path', () => {
    expect(formatGitOrigin(ORIGIN)).toBe('Acme/Widgets · feature/x — packages/x/.claude/skills/foo');
  });

  it('omits empty branch and rel_path parts', () => {
    expect(formatGitOrigin({ ...ORIGIN, branch: '', rel_path: '' })).toBe('Acme/Widgets');
  });

  it('full name falls back to name when owner missing', () => {
    expect(gitOriginRepoFullName({ ...ORIGIN, owner: '' })).toBe('Widgets');
  });
});

describe('completeness + reading off an entity', () => {
  it('complete only with owner, name and a safe rel_path', () => {
    expect(isCompleteGitOrigin(ORIGIN)).toBe(true);
    expect(isCompleteGitOrigin({ ...ORIGIN, owner: '' })).toBe(false);
    expect(isCompleteGitOrigin({ ...ORIGIN, rel_path: '../x' })).toBe(false);
    expect(isCompleteGitOrigin(null)).toBe(false);
  });

  it('gitOriginOf reads git_origin off a received entity, null when absent', () => {
    expect(gitOriginOf({ git_origin: ORIGIN })).toEqual(ORIGIN);
    expect(gitOriginOf({})).toBeNull();
    expect(gitOriginOf(null)).toBeNull();
  });
});
