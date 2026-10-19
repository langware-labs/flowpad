import { expect, test, type APIRequestContext } from '@playwright/test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apiBase } from '../_shared/api';

/**
 * Agent Deploy checklist → "Set up" Git must not report success for a
 * repository that was never created.
 *
 * Drives the real surface end to end: the agent editor's Deploy tab, the
 * checklist's repo-row button, the git-context-folder wizard it launches, and
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
  if (!AGENT_ID) AGENT_ID = await seedAgent(request);
  const before = await preflightCode(request);
  expect(NEEDS_SETUP, `precondition: the agent folder still needs git setup (got ${before})`).toContain(before);

  await page.goto(`/dock/assets/editor/agent/typeid/agent-${AGENT_ID}`);
  await page.getByRole('tab', { name: 'Deploy' }).click();

  const setUp = page.getByTestId('agent-deploy-action-repo');
  await expect(setUp).toBeVisible();

  const created = page.waitForResponse(
    (r) => r.url().includes('/createProcess') && r.request().method() === 'POST',
  );
  await setUp.click();
  const processId: string = (await (await created).json()).data.id;
  createdProcesses.add(processId);

  // The wizard popup is where the setup agent runs; it closing is the caller's
  // promise resolving — with whatever verdict the popup decided on.
  const wizard = page.getByRole('dialog', { name: 'Set up Git for deploying' });
  await expect(wizard).toBeVisible();
  const recheck = page.waitForResponse((r) => r.url().includes('/git_share_preflight'));
  await expect(wizard).toBeHidden();
  await recheck;

  const claimedSuccess = await page.getByText('Git is set up').isVisible();

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
