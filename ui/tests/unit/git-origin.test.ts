import { describe, expect, it } from 'vitest';
import {
  formatGitOrigin,
  gitOriginOf,
  gitOriginRepoFullName,
  gitOriginWebUrl,
  isCompleteGitOrigin,
  isSafeRelPath,
  type GitOrigin,
} from '@sdk';

// FE mirror of the backend git-origin contract (flow_sdk/builtin/git_origin.py
// + tests/unit/test_git_origin_placement.py). FE and BE MUST agree on what a
// safe repo-relative path is and how provenance is read off a received entity.

const ORIGIN: GitOrigin = {
  kind: 'git',
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

describe('gitOriginWebUrl — the page a human opens', () => {
  const origin = (over: Partial<GitOrigin> = {}): GitOrigin => ({ ...ORIGIN, rel_path: 'docs/readme.md', ...over });

  it('deep-links a file, keeping a slashed branch name intact', () => {
    expect(gitOriginWebUrl(origin())).toBe(
      'https://github.com/Acme/Widgets/blob/feature/x/docs/readme.md',
    );
  });

  it('uses tree for a directory', () => {
    expect(gitOriginWebUrl(origin({ rel_path: 'docs' }), { isDir: true })).toBe(
      'https://github.com/Acme/Widgets/tree/feature/x/docs',
    );
  });

  it('drops a .git suffix from the repo name', () => {
    expect(gitOriginWebUrl(origin({ name: 'Widgets.git' }))).toContain('/Acme/Widgets/blob/');
  });

  it('uses the gitlab and bitbucket browse grammars', () => {
    expect(gitOriginWebUrl(origin({ provider: 'gitlab', branch: 'main' }))).toBe(
      'https://gitlab.com/Acme/Widgets/-/blob/main/docs/readme.md',
    );
    expect(gitOriginWebUrl(origin({ provider: 'bitbucket', branch: 'main' }))).toBe(
      'https://bitbucket.org/Acme/Widgets/src/main/docs/readme.md',
    );
  });

  it('falls back to the head commit when there is no branch', () => {
    expect(gitOriginWebUrl(origin({ branch: '', head_commit: 'abc123' }))).toBe(
      'https://github.com/Acme/Widgets/blob/abc123/docs/readme.md',
    );
  });

  it('falls back to the repo root without a ref, at the root, or on an unsafe path', () => {
    const root = 'https://github.com/Acme/Widgets';
    expect(gitOriginWebUrl(origin({ branch: '', head_commit: null }))).toBe(root);
    expect(gitOriginWebUrl(origin({ rel_path: '.' }))).toBe(root);
    expect(gitOriginWebUrl(origin({ rel_path: '../outside' }))).toBe(root);
    expect(gitOriginWebUrl(origin({ rel_path: '/abs/path' }))).toBe(root);
  });

  it('has no web URL for a file remote, an unknown provider, or a nameless repo', () => {
    expect(gitOriginWebUrl(origin({ provider: 'file', owner: '/srv/git' }))).toBeNull();
    expect(gitOriginWebUrl(origin({ provider: '' }))).toBeNull();
    expect(gitOriginWebUrl(origin({ owner: '' }))).toBeNull();
  });

  it('encodes path segments', () => {
    expect(gitOriginWebUrl(origin({ rel_path: 'docs/my notes.md' }))).toBe(
      'https://github.com/Acme/Widgets/blob/feature/x/docs/my%20notes.md',
    );
  });
});
