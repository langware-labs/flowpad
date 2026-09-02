import {
  gitShareGateState,
  type GitShareGateState,
} from '@src/components/share-to-conversation/git-share-gate-state';

/**
 * What has to be true before an agent can be deployed to the cloud, as data.
 *
 * The order and the membership of this list are not a UI choice — they mirror
 * the gates the backend actually runs, so a green checklist means the deploy
 * will get past them:
 *
 *   `cloud_deploy.py`         load_credentials().api_key  → "Cloud login required"
 *   `_publish_service.py:61`  project.remote is True      → PROJECT_NOT_PUBLISHED
 *   `_publish_service.py:80`  get_github_token(actor)     → GITHUB_NOT_CONNECTED
 *   `asset_publisher.py:39`   git repo + GitHub origin    → NOT_GIT_BACKED / ORIGIN_INVALID
 *   `asset_publisher.py:48`   branch aligned with remote  → BRANCH_AHEAD / BRANCH_DIVERGED
 *
 * Pure and React-free on purpose: the mapping is the part worth pinning in a
 * test, and it stays pinnable only while it takes plain values in.
 */

export type DeployStepId = 'cloud-login' | 'github' | 'project' | 'repo' | 'pushed';

/**
 * `done`     — satisfied.
 * `todo`     — unsatisfied, and the user can fix it here.
 * `pending`  — not knowable until an earlier step lands (there is no "is it
 *              pushed" answer for a directory that is not a repository yet).
 * `checking` — no answer has come back.
 * `blocked`  — a real state that neither remediation resolves.
 */
export type DeployStepState = 'done' | 'todo' | 'pending' | 'checking' | 'blocked';

/** Gate order. `deployBlocker` walks this, so it defines "the next thing to do". */
export const DEPLOY_STEP_IDS = ['cloud-login', 'github', 'project', 'repo', 'pushed'] as const;

export type DeployReadiness = Record<DeployStepId, DeployStepState>;

export interface DeployReadinessInput {
  /** `useCloudAuthed()` — already a settled boolean, never pending. */
  cloudAuthed: boolean;
  /** `fetchGithubStatus()`; `null` = no answer yet. */
  githubConnected: boolean | null;
  /** `project.remote === true`; `null` = the project hasn't loaded. */
  projectPublished: boolean | null;
  /** The `git_share_preflight` verdict, straight off `useGitSharePreflight`. */
  preflight: { answered: boolean; loading: boolean; code: string | null };
}

/**
 * The two git rows read ONE backend answer.
 *
 * `git_share_preflight` deliberately returns only the first blocking reason, so
 * "is there a repo" and "is it pushed" are not independently observable — a
 * directory with no repo says `not-in-repo` and nothing at all about its
 * commits. `gitShareGateState` is the existing code→remedy table
 * (`git-share-gate-state.ts`); going through it means a new backend code lands
 * here for free instead of needing a second list to be kept in sync.
 */
const GIT_ROWS: Record<GitShareGateState, [repo: DeployStepState, pushed: DeployStepState]> = {
  checking: ['checking', 'checking'],
  // No repo / no usable origin. Whether its content has travelled is unanswered,
  // not false — `pending`, so the row doesn't accuse the user of a second fault.
  setup: ['todo', 'pending'],
  // Reaching "commit" proves a repo with an origin exists; that IS the repo row.
  commit: ['done', 'todo'],
  ready: ['done', 'done'],
  blocked: ['blocked', 'blocked'],
};

function fromAnswer(value: boolean | null): DeployStepState {
  if (value === null) return 'checking';
  return value ? 'done' : 'todo';
}

export function deployReadiness(input: DeployReadinessInput): DeployReadiness {
  const { preflight } = input;
  // IDLE and "available" both carry `code: null`, so `answered` — not the code —
  // separates "not asked yet" from "asked, and it's fine".
  const gate: GitShareGateState =
    preflight.loading || !preflight.answered ? 'checking' : gitShareGateState(preflight.code);
  const [repo, pushed] = GIT_ROWS[gate];

  return {
    'cloud-login': input.cloudAuthed ? 'done' : 'todo',
    github: fromAnswer(input.githubConnected),
    project: fromAnswer(input.projectPublished),
    repo,
    pushed,
  };
}

/**
 * The one step that gets a button: the first that isn't `done`, in gate order.
 *
 * One actionable fix at a time, matching the backend preflight's own ordering —
 * offering to push a repository that does not exist yet is a button that cannot
 * work. `null` when everything is done.
 */
export function deployBlocker(states: DeployReadiness): DeployStepId | null {
  return DEPLOY_STEP_IDS.find((id) => states[id] !== 'done') ?? null;
}

/**
 * Tri-state readiness for the host's Deploy button.
 *
 * `null` — still checking — is NOT `false`: a slow or unanswerable probe must
 * never take away a button that works today. Only a step we positively know is
 * unmet disables Deploy; the backend's error toast stays the backstop.
 */
export function deployReadyState(states: DeployReadiness): boolean | null {
  if (DEPLOY_STEP_IDS.every((id) => states[id] === 'done')) return true;
  if (DEPLOY_STEP_IDS.some((id) => states[id] === 'todo' || states[id] === 'blocked')) return false;
  return null;
}
