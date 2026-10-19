/**
 * Browser scenario — a box BOUND TO A HUB LLMENDPOINT whose own row is unrestricted, but
 * whose CHAIN (a parent pool two hops up, the same shape a real team → org chain has) narrows
 * which model the agent fallback may use.
 *
 * Backend: `start_backend.py --scenario hub-endpoint` (a fake hub, see
 * `tests/utils/fake_llm_hub_server.py`) rejects this box's own sm-tier default and only
 * accepts `EXPECTED_MODEL` — a model name that exists NOWHERE but in the fake chain response,
 * so a pass proves the fallback actually read the chain rather than guessing right.
 *
 * Three steps, mirroring llm-setup's own shape:
 *   1. git   — already on every runner: validation only, no install.
 *   2. tree  — a correct, genuinely tiny install: succeeds via the plain CLI command.
 *   3. figlet — a DELIBERATELY BROKEN CLI command: falls to the agent, which installs the
 *      real thing for real (so the completion check that follows is not stubbed) — and must
 *      show `EXPECTED_MODEL`, the model this scenario's fake chain (not the client's own
 *      tier default) allows.
 */
import { execSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';

const WIZARD_NAME = 'e2e-hub-endpoint-setup';
const STEPS = ['git', 'tree', 'figlet'];
const UNSETTLED = new Set(['not_reached', 'running']);
const EXPECTED_MODEL = process.env.LLM_HUB_EXPECTED_MODEL;
const BE_PORT = process.env.LLM_HUB_BE_PORT;

if (!EXPECTED_MODEL || !BE_PORT) {
  throw new Error('LLM_HUB_EXPECTED_MODEL and LLM_HUB_BE_PORT must be set — see start_backend.py');
}

function toolPresent(tool: string): boolean {
  try {
    execSync(`command -v ${tool}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function uninstall(tool: string): void {
  const cmd = process.platform === 'darwin' ? `brew uninstall --force ${tool}` : `apt-get remove -y ${tool}`;
  try {
    execSync(cmd, { stdio: 'ignore' });
  } catch {
    /* best-effort cleanup — a failed uninstall must not fail the run */
  }
}

async function stepStatuses(page: Page): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const id of STEPS) {
    out[id] = (await page.getByTestId(`wizard-step-${id}`).getAttribute('data-status')) ?? '';
  }
  return out;
}

test.beforeAll(() => {
  // The whole point of steps 2/3 is proving a genuine install — a leftover from an earlier
  // run (or the runner's own image) would make both "already installed" and "we installed it"
  // look identical.
  for (const tool of ['tree', 'figlet']) {
    expect(toolPresent(tool), `${tool} must not already be on this machine before the test starts`).toBe(false);
  }
});

test.afterAll(() => {
  for (const tool of ['tree', 'figlet']) uninstall(tool);
});

test('a box bound to a hub LLMEndpoint falls back to the model its CHAIN allows, not the client default', async ({
  page,
  request,
}) => {
  // A freshly-booted backend indexes shipped assets asynchronously — the wizard is not
  // guaranteed to exist the instant bootstrap answers "types".
  let wizard: { id: string } | undefined;
  await expect(async () => {
    const listing = await request.get(`http://localhost:${BE_PORT}/api/v1/graph/wizard?limit=200`);
    wizard = (await listing.json()).data.find((w: { name: string }) => w.name === WIZARD_NAME);
    expect(wizard, `${WIZARD_NAME} is not indexed yet`).toBeTruthy();
  }).toPass({ timeout: 20_000 });

  await page.goto(`/dock/assets/editor/wizard/typeid/wizard-${wizard!.id}`);
  const viewer = page.getByTestId('wizard-viewer');
  await expect(viewer.getByRole('heading', { name: WIZARD_NAME })).toBeVisible();
  await page.getByTestId('wizard-run').click();

  // This fixture is indexed from a test-only folder, not the shipped flowpad_assistant tree,
  // so the backend correctly reports it as unshipped and the UI asks for one-time approval
  // before running shell commands from it.
  await page.getByTestId('wizard-approve').click();

  const modal = page.getByTestId('ask-modal');
  await expect(async () => {
    if (await modal.isVisible()) {
      await page.getByTestId('ask-modal-submit').click();
    }
    const statuses = await stepStatuses(page);
    const pending = Object.entries(statuses).filter(([, s]) => UNSETTLED.has(s));
    expect(pending, `steps still without an answer: ${JSON.stringify(statuses)}`).toEqual([]);
  }).toPass({ timeout: 90_000 }); // do not increase timeout without approval

  const statuses = await stepStatuses(page);
  expect(['satisfied', 'completed'], `git is on every runner: ${JSON.stringify(statuses)}`).toContain(statuses.git);
  expect(statuses.tree, 'tree installs via the plain CLI command').toBe('completed');
  expect(statuses.figlet, 'figlet falls to the agent').toBe('completed');

  const figletModel = page.getByTestId('wizard-step-figlet').getByTestId('wizard-step-agent-model');
  await expect(figletModel).toContainText(EXPECTED_MODEL);

  expect(toolPresent('tree'), 'tree was really installed, not stubbed').toBe(true);
  expect(toolPresent('figlet'), 'figlet was really installed by the agent, not stubbed').toBe(true);
});
