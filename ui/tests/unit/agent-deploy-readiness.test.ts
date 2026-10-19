/**
 * The deploy-readiness state machine — `deploy-readiness.ts`.
 *
 * What is pinned here is the MAPPING, not the rendering: which answer makes
 * which row done, which row is the one actionable blocker, and when the host
 * may disable Deploy. A deploy publishes the agent into its project's
 * hub-hosted repository, so the only gates are a cloud login and a linked
 * project; the published-version row is advice and never disables Deploy.
 */
import { describe, expect, it } from 'vitest';

import {
  DEPLOY_STEP_IDS,
  deployBlocker,
  deployReadiness,
  deployReadyState,
  type DeployReadinessInput,
} from '@src/components/assets/editor/agent-profile/deploy-readiness';

/** Everything satisfied. */
const ALL_GOOD: DeployReadinessInput = {
  cloudAuthed: true,
  projectPublished: true,
  version: { published: true, pending_changes: 0 },
};

describe('deployReadiness', () => {
  it('has exactly the cloud-login, project and version rows — no git or GitHub gates', () => {
    expect([...DEPLOY_STEP_IDS]).toEqual(['cloud-login', 'project', 'version']);
  });

  it('marks every step done when all gates are satisfied', () => {
    const states = deployReadiness(ALL_GOOD);

    for (const id of DEPLOY_STEP_IDS) expect(states[id]).toBe('done');
    expect(deployBlocker(states)).toBeNull();
    expect(deployReadyState(states)).toBe(true);
  });

  it('reports an unmet gate as todo, and a known unmet gate disables Deploy', () => {
    const noLogin = deployReadiness({ ...ALL_GOOD, cloudAuthed: false });
    const notLinked = deployReadiness({ ...ALL_GOOD, projectPublished: false });

    expect(noLogin['cloud-login']).toBe('todo');
    expect(notLinked.project).toBe('todo');
    expect(deployReadyState(noLogin)).toBe(false);
    expect(deployReadyState(notLinked)).toBe(false);
  });

  it('treats a project that has not loaded as checking, and never as ready or not-ready', () => {
    const states = deployReadiness({ ...ALL_GOOD, projectPublished: null });

    expect(states.project).toBe('checking');
    expect(deployReadyState(states)).toBeNull();
  });

  it('offers only the first unmet gate, in gate order', () => {
    const states = deployReadiness({ cloudAuthed: false, projectPublished: false, version: null });

    expect(deployBlocker(states)).toBe('cloud-login');
    expect(deployBlocker(deployReadiness({ ...ALL_GOOD, projectPublished: false }))).toBe('project');
  });
});

describe('the published-version row', () => {
  it('is todo when the published version lacks this computer’s edits — but Deploy stays enabled', () => {
    const states = deployReadiness({ ...ALL_GOOD, version: { published: true, pending_changes: 2 } });

    expect(states.version).toBe('todo');
    expect(deployBlocker(states)).toBe('version');
    // Advice, not a gate: a stale published version still deploys.
    expect(deployReadyState(states)).toBe(true);
  });

  it('is done for an agent that was never published — the deploy publishes this version', () => {
    const states = deployReadiness({ ...ALL_GOOD, version: { published: false, pending_changes: 3 } });

    expect(states.version).toBe('done');
  });

  it('is checking while the version is unknown, without holding Deploy back', () => {
    const states = deployReadiness({ ...ALL_GOOD, version: null });

    expect(states.version).toBe('checking');
    expect(deployReadyState(states)).toBe(true);
  });
});
