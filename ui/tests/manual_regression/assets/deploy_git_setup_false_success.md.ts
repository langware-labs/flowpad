import { expect, test, type APIRequestContext } from '@playwright/test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apiBase } from '../_shared/api';

/**
 * Deploy checklist → "Add git" must not report success for a repository that
 * was never created.
 *
 * Drives the real surface end to end: the agent's Deploy (its project's
 * Deployments page), the New deployment checklist's "Git is required · Add git",
 * the git setup wizard and the git-dependency agent it launches, and
 * the backend's own verdicts. Nothing is mocked — the assertions read ground
 * truth from the backend (the wizard worker's transcript and
 * `git_share_preflight`), not the popup, because the popup is what lies.
 *
 * Targets an agent whose project folder still needs git setup (no repository,
 * or no usable GitHub origin). By default the test seeds one — a fresh project
 * in a temp folder that is not a git repository, with an agent in it — so it
 * runs on any instance. Set QA_DEPLOY_AGENT_ID to point it at an existing one.
 *
 * LIVE-ONLY. A green run needs the wizard's real Claude agent to finish the
 * setup, and "set up" here means a SUPPORTED origin (git_share_preflight counts
 * `missing-remote` / `unsupported-origin` as still needing setup): the agent
 * must create or link a hosted (GitHub) repository. That is a multi-minute
 * live-Claude run with an outward-facing side effect, so it only runs when
 * explicitly opted into with QA_DEPLOY_LIVE_GIT=1.
 */

const API = apiBase();
const LIVE = process.env.QA_DEPLOY_LIVE_GIT === '1';
/** The ONE throwaway repository a live run creates (the runner deletes it afterwards). */
const REPO_NAME = process.env.QA_DEPLOY_REPO_NAME || `flowpad-qa-deploy-git-${Date.now()}`;
let AGENT_ID = process.env.QA_DEPLOY_AGENT_ID || '';
let seededProject: { id: string; root: string } | null = null;

/** `git_share_preflight` codes the checklist offers "Set up" for (`gitShareGateState` → `setup`). */
const NEEDS_SETUP = ['not-in-repo', 'missing-remote', 'unsupported-origin'];

const createdProcesses = new Set<string>();

async function preflightCode(request: APIRequestContext): Promise<string | null> {
  const res = await request.get(`${API}/api/v1/graph/agent/${AGENT_ID}/git_share_preflight`);
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).data.code ?? null;
}

async function transcriptCount(request: APIRequestContext, processId: string): Promise<number> {
  const res = await request.get(`${API}/api/v1/graph/agentic_process/${processId}/get-history`);
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).data.count ?? 0;
}

/** A project in a temp folder that is NOT a git repository, with an agent in it. */
async function seedAgent(request: APIRequestContext): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'flowpad-deploy-git-')));
  const project = await request.post(`${API}/api/v1/graph/project`, {
    data: { name: path.basename(root), fs_storage_mount_path: root },
  });
  expect(project.status(), await project.text()).toBe(200);
  seededProject = { id: (await project.json()).data.id, root };
  const agent = await request.post(`${API}/api/v1/graph/project/${seededProject.id}/agent`, {
    data: { name: `deploy-git-${path.basename(root)}` },
  });
  expect(agent.status(), await agent.text()).toBe(200);
  return (await agent.json()).data.id;
}

test.afterEach(async ({ request }) => {
  for (const id of createdProcesses) {
    await request.delete(`${API}/api/v1/graph/agentic_process/${id}`).catch(() => undefined);
  }
  createdProcesses.clear();
  if (seededProject) {
    await request.delete(`${API}/api/v1/graph/project/${seededProject.id}`).catch(() => undefined);
    await fs.rm(seededProject.root, { recursive: true, force: true });
    seededProject = null;
  }
});

test('Set up Git only reports success once the repository exists', async ({ page, request }) => {
  test.skip(
    !LIVE,
    'live-claude: the wizard agent must actively run the setup to completion and create/link a hosted (GitHub) ' +
      'origin — a multi-minute real Claude run with an external side effect. Opt in with QA_DEPLOY_LIVE_GIT=1.',
  );
  // The documented multi-minute live run (a real Claude wizard agent creating a hosted repository).
  test.setTimeout(12 * 60_000);
  if (!AGENT_ID) AGENT_ID = await seedAgent(request);
  const before = await preflightCode(request);
  expect(NEEDS_SETUP, `precondition: the agent folder still needs git setup (got ${before})`).toContain(before);

  // A deployment places a project (aeb735d41): the agent's Deploy opens its project's Deployments page,
  // whose New deployment checklist puts "Git is required · Add git" in front of a project with no git.
  await page.goto(`/dock/assets/editor/agent/typeid/agent-${AGENT_ID}`);
  await page.getByTestId('agent-tab-summary').click();
  await page.getByTestId('agent-summary-new-deployment').click();
  await page.getByTestId('project-new-deployment').click();
  const dialog = page.getByTestId('new-deployment-dialog');
  await dialog.locator('[data-testid^="new-deployment-size-"]').first().click();
  await dialog.getByTestId('new-deployment-next').click();
  await dialog.getByTestId('new-deployment-tab-values-button').click();

  const setUp = dialog.getByTestId('git-required-add');
  await expect(setUp).toBeVisible();
  await setUp.click();

  // The git setup wizard: a NEW GitHub repository, set up by the git-dependency wizard agent.
  const wizard = page.getByTestId('git-setup-wizard');
  await expect(wizard).toBeVisible();
  await wizard.getByTestId('git-setup-mode-new').click();
  await wizard.getByTestId('git-setup-name').fill(REPO_NAME);
  const created = page.waitForResponse(
    (r) => r.url().includes('/createProcess') && r.request().method() === 'POST',
  );
  await wizard.getByTestId('git-setup-next').click();
  const processId: string = (await (await created).json()).data.id;
  createdProcesses.add(processId);

  // The agent's run ends either way: done (the wizard says so) or back on its first step.
  await expect(wizard.getByTestId('git-setup-running')).toBeHidden({ timeout: 10 * 60_000 });
  const claimedSuccess = await wizard.getByTestId('git-setup-done').isVisible();

  // Ground truth 1: the setup agent actually ran and said something.
  expect(
    await transcriptCount(request, processId),
    `wizard process ${processId} closed (success toast shown: ${claimedSuccess}) but its agent produced no transcript`,
  ).toBeGreaterThan(0);

  // Ground truth 2: the thing it was launched to do happened.
  const after = await preflightCode(request);
  expect(
    NEEDS_SETUP,
    `wizard closed (success toast shown: ${claimedSuccess}) but git is still not set up (${before} → ${after})`,
  ).not.toContain(after);
});
