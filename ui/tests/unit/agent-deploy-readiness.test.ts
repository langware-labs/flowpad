/**
 * The deploy-readiness state machine — `deploy-readiness.ts`.
 *
 * What is pinned here is the MAPPING, not the rendering: which backend answer
 * makes which row done, which row is the one actionable blocker, and when the
 * host may disable Deploy. The git half deliberately goes through
 * `gitShareGateState`, whose own code table is pinned by
 * `tests/unit/git-share-gate-state.test.ts` — the two together are the contract
 * with `flow_sdk/app/actions/git_share_preflight_action.py`.
 */
import { describe, expect, it } from 'vitest';

import {
  DEPLOY_STEP_IDS,
  deployBlocker,
  deployReadiness,
  deployReadyState,
  type DeployReadinessInput,
} from '@src/components/assets/editor/agent-profile/deploy-readiness';

/** Everything satisfied — the only input for which Deploy is enabled. */
const ALL_GOOD: DeployReadinessInput = {
  cloudAuthed: true,
  githubConnected: true,
  projectPublished: true,
  preflight: { answered: true, loading: false, code: null },
};

const answered = (code: string | null) => ({ answered: true, loading: false, code });

describe('deployReadiness', () => {
  it('marks every step done when all five gates are satisfied', () => {
    const states = deployReadiness(ALL_GOOD);

    for (const id of DEPLOY_STEP_IDS) expect(states[id]).toBe('done');
    expect(deployBlocker(states)).toBeNull();
    expect(deployReadyState(states)).toBe(true);
  });

  it('reports an unmet gate as todo', () => {
    expect(deployReadiness({ ...ALL_GOOD, cloudAuthed: false })['cloud-login']).toBe('todo');
    expect(deployReadiness({ ...ALL_GOOD, githubConnected: false }).github).toBe('todo');
    expect(deployReadiness({ ...ALL_GOOD, projectPublished: false }).project).toBe('todo');
  });

  it('treats an unanswered probe as checking, and never as ready', () => {
    const states = deployReadiness({ ...ALL_GOOD, githubConnected: null });

    expect(states.github).toBe('checking');
    // Not `false`: an unanswerable probe is not evidence of a missing grant, so
    // it must not take away a Deploy button that works.
    expect(deployReadyState(states)).toBeNull();
  });

  it('is checking on both git rows until the preflight answers', () => {
    const idle = deployReadiness({ ...ALL_GOOD, preflight: { answered: false, loading: false, code: null } });
    const inFlight = deployReadiness({ ...ALL_GOOD, preflight: { answered: true, loading: true, code: null } });

    // IDLE and "available" both carry `code: null` — `answered` is what separates them.
    expect(idle.repo).toBe('checking');
    expect(idle.pushed).toBe('checking');
    expect(inFlight.repo).toBe('checking');
    expect(deployReadyState(idle)).toBeNull();
  });

  it.each([
    ['not-in-repo', 'todo', 'pending'],
    ['missing-remote', 'todo', 'pending'],
    ['unsupported-origin', 'todo', 'pending'],
  ])('maps %s to a repo the user must set up, with the push question unanswered', (code, repo, pushed) => {
    const states = deployReadiness({ ...ALL_GOOD, preflight: answered(code) });

    expect(states.repo).toBe(repo);
    // `pending`, not `todo`: there is no "is it pushed" answer for a directory
    // that is not a repository yet, and a second red row would be an invention.
    expect(states.pushed).toBe(pushed);
  });

  it.each(['dirty', 'no-commit', 'unpushed'])(
    'maps %s to a repo that exists with content that has not travelled',
    (code) => {
      const states = deployReadiness({ ...ALL_GOOD, preflight: answered(code) });

      // Reaching a commit state proves the repository and its origin exist.
      expect(states.repo).toBe('done');
      expect(states.pushed).toBe('todo');
      expect(deployBlocker(states)).toBe('pushed');
    },
  );

  it('marks both git rows done when the preflight is available', () => {
    const states = deployReadiness({ ...ALL_GOOD, preflight: answered(null) });

    expect(states.repo).toBe('done');
    expect(states.pushed).toBe('done');
  });

  it.each(['detached-head', 'status-failure', 'not-file-backed', 'some-future-code'])(
    'fails closed to blocked on %s',
    (code) => {
      const states = deployReadiness({ ...ALL_GOOD, preflight: answered(code) });

      expect(states.repo).toBe('blocked');
      expect(states.pushed).toBe('blocked');
      // Blocked is a known-bad state, so Deploy is positively not ready.
      expect(deployReadyState(states)).toBe(false);
    },
  );
});

describe('deployBlocker', () => {
  it('returns the first unmet step in gate order, not the first it finds', () => {
    const states = deployReadiness({
      cloudAuthed: false,
      githubConnected: false,
      projectPublished: false,
      preflight: answered('not-in-repo'),
    });

    // Four rows are unmet; only the earliest gate is offered, because fixing a
    // later one first cannot help.
    expect(deployBlocker(states)).toBe('cloud-login');
    expect(DEPLOY_STEP_IDS[0]).toBe('cloud-login');
  });

  it('walks past done steps', () => {
    const states = deployReadiness({ ...ALL_GOOD, githubConnected: false, projectPublished: false });

    expect(deployBlocker(states)).toBe('github');
  });

  it('offers the git rows only once the account gates are done', () => {
    const states = deployReadiness({ ...ALL_GOOD, preflight: answered('not-in-repo') });

    expect(deployBlocker(states)).toBe('repo');
  });
});
