import { describe, expect, it } from 'vitest';
import {
  deriveRepoState,
  type ProjectGitState,
} from '@src/hooks/use-project-repo-state';

const REPO = { full_name: 'langware-labs/flowpad', branch: 'main' };

function state(overrides: Partial<ProjectGitState> = {}): ProjectGitState {
  return {
    has_repo: true,
    remote_full_name: 'langware-labs/flowpad',
    current_branch: 'main',
    has_uncommitted: false,
    ahead_of_remote: false,
    behind_remote: false,
    head_commit: 'abc123',
    workdir: '/tmp/proj',
    workdir_exists: true,
    ...overrides,
  };
}

describe('deriveRepoState', () => {
  it('returns null when either input is null', () => {
    expect(deriveRepoState(null, REPO)).toBe(null);
    expect(deriveRepoState(state(), null)).toBe(null);
  });

  it('NO_WORKDIR when project has no workdir set', () => {
    expect(deriveRepoState(state({ workdir: null, workdir_exists: false }), REPO)).toBe('NO_WORKDIR');
  });

  it('NO_WORKDIR when workdir is set but does not exist on disk', () => {
    expect(deriveRepoState(state({ workdir: '/tmp/missing', workdir_exists: false }), REPO)).toBe('NO_WORKDIR');
  });

  it('CLONE when the workdir is present but has no .git', () => {
    expect(deriveRepoState(state({ has_repo: false, remote_full_name: null, current_branch: null }), REPO)).toBe('CLONE');
  });

  it('INCOMPATIBLE_REPO when the local .git points at a different remote', () => {
    expect(
      deriveRepoState(state({ remote_full_name: 'other-org/other-repo' }), REPO),
    ).toBe('INCOMPATIBLE_REPO');
  });

  it('CHECKOUT when same repo but different branch', () => {
    expect(deriveRepoState(state({ current_branch: 'feature-x' }), REPO)).toBe('CHECKOUT');
  });

  it('CHECKOUT for detached HEAD (current_branch=null) even with the same remote', () => {
    expect(deriveRepoState(state({ current_branch: null }), REPO)).toBe('CHECKOUT');
  });

  it('COMMIT_AND_PULL when same branch with uncommitted local changes', () => {
    expect(deriveRepoState(state({ has_uncommitted: true }), REPO)).toBe('COMMIT_AND_PULL');
  });

  it('COMMIT_AND_PULL wins over PULL when both uncommitted and behind', () => {
    expect(
      deriveRepoState(state({ has_uncommitted: true, behind_remote: true }), REPO),
    ).toBe('COMMIT_AND_PULL');
  });

  it('PULL when clean tree but remote ahead', () => {
    expect(deriveRepoState(state({ behind_remote: true }), REPO)).toBe('PULL');
  });

  it('UP_TO_DATE when clean tree, same branch, no remote diff', () => {
    expect(deriveRepoState(state(), REPO)).toBe('UP_TO_DATE');
  });

  it('UP_TO_DATE even when ahead_of_remote (local has commits to push) — sharing semantics only care about behind', () => {
    expect(deriveRepoState(state({ ahead_of_remote: true }), REPO)).toBe('UP_TO_DATE');
  });
});
