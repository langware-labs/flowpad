/**
 * Browser scenario — a box with NO LLMEndpoint of its own, funded only by the hub's global
 * default budget (whatever provider actually backs that today — deliberately not named here;
 * see `LLM_GLOBAL_EXPECTED_MODEL` below).
 *
 * Backend: `start_backend.py --scenario global-default` binds the box to a fake endpoint whose
 * chain carries no restriction at all, and accepts exactly the CLIENT'S OWN sm-tier default
 * (`DEEPAGENTS_MODEL_TIERS["sm"]`, read at backend-start time — never a literal copied into
 * this spec, so a provider swap changes what this test expects right along with the app).
 *
 * Three steps, mirroring llm-setup's own shape:
 *   1. git    — already on every runner: validation only, no install.
 *   2. cowsay — a correct, genuinely tiny install: succeeds via the plain CLI command.
 *   3. sl     — a DELIBERATELY BROKEN CLI command: falls to the agent, which installs the
 *      real thing for real — and must show the client's own default model, proving an
 *      unrestricted budget resolves to THAT rather than anything this spec invents.
 */
import { execSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';

const WIZARD_NAME = 'e2e-global-default-setup';
const STEPS = ['git', 'cowsay', 'sl'];
const UNSETTLED = new Set(['not_reached', 'running']);
const EXPECTED_MODEL = process.env.LLM_GLOBAL_EXPECTED_MODEL;
const BE_PORT = process.env.LLM_GLOBAL_BE_PORT;

if (!EXPECTED_MODEL || !BE_PORT) {
  throw new Error('LLM_GLOBAL_EXPECTED_MODEL and LLM_GLOBAL_BE_PORT must be set — see start_backend.py');
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
  for (const tool of ['cowsay', 'sl']) {
    expect(toolPresent(tool), `${tool} must not already be on this machine before the test starts`).toBe(false);
  }
});

test.afterAll(() => {
  for (const tool of ['cowsay', 'sl']) uninstall(tool);
});

test('a box with no hub LLMEndpoint falls back to the global default model', async ({ page, request }) => {
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
  expect(statuses.cowsay, 'cowsay installs via the plain CLI command').toBe('completed');
  expect(statuses.sl, 'sl falls to the agent').toBe('completed');

  const slModel = page.getByTestId('wizard-step-sl').getByTestId('wizard-step-agent-model');
  await expect(slModel).toContainText(EXPECTED_MODEL);

  expect(toolPresent('cowsay'), 'cowsay was really installed, not stubbed').toBe(true);
  expect(toolPresent('sl'), 'sl was really installed by the agent, not stubbed').toBe(true);
});
