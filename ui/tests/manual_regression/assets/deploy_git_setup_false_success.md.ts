import { expect, test, type APIRequestContext } from '@playwright/test';
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
 * or no usable GitHub origin). Set
 * QA_DEPLOY_AGENT_ID to point it at a different one.
 */

const API = apiBase();
const AGENT_ID = process.env.QA_DEPLOY_AGENT_ID || '002c95c3-dc3d-4c8e-90e3-d484a07b47ca';

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

test.afterEach(async ({ request }) => {
  for (const id of createdProcesses) {
    await request.delete(`${API}/api/v1/graph/agentic_process/${id}`).catch(() => undefined);
  }
  createdProcesses.clear();
});

test('Set up Git only reports success once the repository exists', async ({ page, request }) => {
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
