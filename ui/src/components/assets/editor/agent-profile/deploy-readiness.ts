/**
 * What has to be true before an agent can be deployed to the cloud, as data.
 *
 * The membership of this list is not a UI choice — it mirrors the gates the
 * backend actually runs, so a green checklist means the deploy will get past
 * them:
 *
 *   `cloud_deploy.py`     a live hub login                 → "Cloud login required"
 *   `_publish_service.py` project.remote is True           → PROJECT_NOT_PUBLISHED
 *
 * A deploy publishes the agent into its project's HUB-HOSTED repository, so the
 * project folder does not have to be a git checkout, have a remote, be pushed,
 * or have GitHub connected — none of that is a gate any more.
 *
 * `version` is the one OPTIONAL row: whether the published version already has
 * this computer's edits (the agent's `version()` `pending_changes`). It never
 * disables Deploy — a stale published version still deploys — it only offers to
 * publish the edits first.
 *
 * Pure and React-free on purpose: the mapping is the part worth pinning in a
 * test, and it stays pinnable only while it takes plain values in.
 */

export type DeployStepId = 'cloud-login' | 'project' | 'version';

/**
 * `done`     — satisfied.
 * `todo`     — unsatisfied, and the user can fix it here.
 * `pending`  — not knowable until an earlier step lands.
 * `checking` — no answer has come back.
 * `blocked`  — a real state no remediation here resolves.
 */
export type DeployStepState = 'done' | 'todo' | 'pending' | 'checking' | 'blocked';

/** Gate order. `deployBlocker` walks this, so it defines "the next thing to do". */
export const DEPLOY_STEP_IDS = ['cloud-login', 'project', 'version'] as const;

/** The steps that must be `done` before Deploy is enabled; the rest are advice. */
export const REQUIRED_DEPLOY_STEP_IDS = ['cloud-login', 'project'] as const satisfies readonly DeployStepId[];

export type DeployReadiness = Record<DeployStepId, DeployStepState>;

/** The agent's `version()` answer, as far as readiness cares. */
export interface DeployVersionInput {
  published: boolean;
  pending_changes: number;
}

export interface DeployReadinessInput {
  /** `useCloudAuthed()` — already a settled boolean, never pending. */
  cloudAuthed: boolean;
  /** `project.remote === true`; `null` = the project hasn't loaded. */
  projectPublished: boolean | null;
  /** `agent.versionState()`; `null` = no answer yet (or it could not be read). */
  version: DeployVersionInput | null;
}

function fromAnswer(value: boolean | null): DeployStepState {
  if (value === null) return 'checking';
  return value ? 'done' : 'todo';
}

/**
 * The published-version row. Never published ⇒ `done`: the deploy publishes
 * this computer's version, so there is nothing to catch up on. Published with
 * edits since ⇒ `todo` (publish them first). Unknown ⇒ `checking`.
 */
function versionState(version: DeployVersionInput | null): DeployStepState {
  if (!version) return 'checking';
  if (!version.published) return 'done';
  return version.pending_changes > 0 ? 'todo' : 'done';
}

export function deployReadiness(input: DeployReadinessInput): DeployReadiness {
  return {
    'cloud-login': input.cloudAuthed ? 'done' : 'todo',
    project: fromAnswer(input.projectPublished),
    version: versionState(input.version),
  };
}

/**
 * The one step that gets a button: the first that isn't `done`, in gate order.
 *
 * One actionable fix at a time — linking a project before signing in to the
 * cloud is a button that cannot work. `null` when everything is done.
 */
export function deployBlocker(states: DeployReadiness): DeployStepId | null {
  return DEPLOY_STEP_IDS.find((id) => states[id] !== 'done') ?? null;
}

/**
 * Tri-state readiness for the host's Deploy button, over the REQUIRED steps only.
 *
 * `null` — still checking — is NOT `false`: a slow or unanswerable probe must
 * never take away a button that works today. Only a step we positively know is
 * unmet disables Deploy; the backend's error toast stays the backstop.
 */
export function deployReadyState(states: DeployReadiness): boolean | null {
  if (REQUIRED_DEPLOY_STEP_IDS.every((id) => states[id] === 'done')) return true;
  if (REQUIRED_DEPLOY_STEP_IDS.some((id) => states[id] === 'todo' || states[id] === 'blocked')) return false;
  return null;
}
