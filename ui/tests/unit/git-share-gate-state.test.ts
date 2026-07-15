import { describe, expect, it } from 'vitest';
import { gitShareGateState } from '@src/components/share-to-conversation/git-share-gate-state';
import { matchContextDir } from '@src/hooks/use-context-folder-for-rel';
import type { ProjectContextDirInfo } from '@sdk';

/**
 * The gate maps every backend preflight code to exactly one of four states.
 * Table-driven over the FULL `_REASONS` set in
 * flow_sdk/app/actions/git_share_preflight_action.py — if a code is added there
 * without a decision here, it lands in `blocked` (fail closed) and this table
 * is where that choice becomes visible.
 */
describe('gitShareGateState', () => {
  const cases: [string | null, string][] = [
    [null, 'ready'],
    // Fixable by the git-setup wizard: no repo / no usable origin yet.
    ['not-in-repo', 'setup'],
    ['missing-remote', 'setup'],
    ['unsupported-origin', 'setup'],
    // Fixable by one commit+push: the content exists, it just hasn't travelled.
    ['dirty', 'commit'],
    ['no-commit', 'commit'],
    ['unpushed', 'commit'],
    // Real states neither button can fix — offering one would be a lie.
    ['detached-head', 'blocked'],
    ['status-failure', 'blocked'],
    ['unresolved-folder', 'blocked'],
    // Setting up git can't give a type an on-disk source it never had.
    ['not-file-backed', 'blocked'],
  ];

  it.each(cases)('code %s → %s', (code, expected) => {
    expect(gitShareGateState(code)).toBe(expected);
  });

  it('fails closed on an unknown code', () => {
    expect(gitShareGateState('some-future-code')).toBe('blocked');
  });

  it('treats undefined as ready, matching a null code from the action', () => {
    expect(gitShareGateState(undefined)).toBe('ready');
  });
});

/**
 * The share target is the context folder CONTAINING the browsed path — only it
 * has a Folder entity and only its root is a repo.
 */
describe('matchContextDir', () => {
  const info = (path: string, extra: Partial<ProjectContextDirInfo> = {}): ProjectContextDirInfo =>
    ({ path, origin_kind: 'git', typeid: `folder-${path}`, ...extra }) as ProjectContextDirInfo;

  it('matches the context dir itself', () => {
    expect(matchContextDir([info('repo')], 'repo')?.path).toBe('repo');
  });

  it('matches a nested path inside the context dir', () => {
    expect(matchContextDir([info('repo')], 'repo/docs/api')?.path).toBe('repo');
  });

  it('does not match a sibling that merely shares a prefix', () => {
    expect(matchContextDir([info('repo')], 'repo-other/docs')).toBeNull();
  });

  it('returns null when no context dir contains the path', () => {
    expect(matchContextDir([info('repo')], 'elsewhere/docs')).toBeNull();
  });

  it('picks the DEEPEST containing dir when they nest', () => {
    const infos = [info('repo'), info('repo/packages/inner')];
    expect(matchContextDir(infos, 'repo/packages/inner/src')?.path).toBe('repo/packages/inner');
  });

  it('returns non-git folders too — the caller offers to set git up', () => {
    const match = matchContextDir([info('plain', { origin_kind: 'local' })], 'plain/notes');
    expect(match?.origin_kind).toBe('local');
  });

  it('ignores infos with an empty path', () => {
    expect(matchContextDir([info('')], 'repo')).toBeNull();
  });
});
