/**
 * Browser scenario — an auto-launched agent must answer AS THE AGENT.
 *
 * Reported on an e2b box: a mail-assistant agent with `auto_launch` opened on
 * project load, the user asked "hi, whats your job", and it answered as vibe.
 *
 *   1. Seed a fresh project with ONE agent: a mail-assistant `system_prompt`,
 *      `auto_launch` on, no auto-launch prompt (the reported shape).
 *   2. Open the project: the dock loader redirects into the agent's session
 *      (POST /api/v1/agents/auto-launch → prepareAgentSession → embed vibe).
 *   3. Ask the agent who it is, through the real composer.
 *   4. Ground truth: the CLAUDE.md the worker was launched with carries the
 *      agent's prompt and no competing "You are the 'vibe' agent" identity.
 *   5. What the user sees: the reply stays an email assistant and does not
 *      pitch vibe's creator job ("build websites … in the display pane").
 *
 * Observed while failing (claude-opus-5): "I am MAILBOT_PROBE, an email
 * assistant … In this workspace I can also build things you describe, like
 * websites, apps, skills, agents … and show them live in the display pane."
 * The reply text is model output, so step 4 (the rendered system prompt) is the
 * deterministic signal and step 5 is the symptom the user reported.
 *
 * Needs a disposable backend + its vite, on the SAME machine (step 4 reads the
 * process's assets folder from disk), and Claude Code logged in.
 *
 * Run:
 *   AL_FE_PORT=4142 AL_BE_PORT=6042 npx playwright test \
 *     --config ui/tests/e2e/agent-auto-launch/playwright.config.ts agent_auto_launch_persona
 */
import { expect, test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const BE = `http://localhost:${process.env.AL_BE_PORT || '6001'}`;
const GRAPH = `${BE}/api/v1/graph`;
const AGENT_NAME = 'MAILBOT_PROBE';
const SYSTEM_PROMPT = `You are ${AGENT_NAME}, an email assistant. Your job is to help the user stay on top of their email.`;
// vibe.md's own vocabulary — none of it belongs in a mail assistant's answer.
const VIBE_PITCH = /display pane|websites|web apps?\b|slide decks?/i;

let projectId = '';
let agentTitle = '';

async function post(url: string, body?: unknown): Promise<any> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  return r.json();
}

test.beforeAll(async () => {
  try {
    const h = await fetch(`${BE}/api/v1/health/status`, { signal: AbortSignal.timeout(2000) });
    if (!h.ok) throw new Error('unhealthy');
  } catch {
    test.skip(true, `backend not up on ${BE} — launch a disposable instance first`);
  }

  const stamp = Date.now();
  const created = await post(`${GRAPH}/project`, { type: 'project', name: `al-persona-e2e-${stamp}` });
  projectId = created?.data?.id;
  if (!projectId) throw new Error(`project create failed: ${JSON.stringify(created).slice(0, 200)}`);

  agentTitle = `Mail Assistant ${stamp}`;
  const res = await post(`${GRAPH}/project/${projectId}/agent`, {
    type: 'agent',
    name: agentTitle,
    title: agentTitle,
    system_prompt: SYSTEM_PROMPT,
    intro: "Hi, I'm your mail assistant. Tell me what you need done with your email.",
    auto_launch: true,
  });
  if (res?.status !== 'SUCCESS') throw new Error(`agent create failed: ${JSON.stringify(res).slice(0, 300)}`);
});

test.afterAll(async () => {
  try {
    if (projectId && !process.env.AL_KEEP) await post(`${GRAPH}/project/${projectId}/delete-with-children`);
  } catch {
    /* best effort — the instance is disposable */
  }
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  });
});

// Watching mode: `AL_HOLD=1 … --headed` leaves the browser open on the final
// state (pass or fail) until Resume is pressed in the Playwright Inspector.
test.afterEach(async ({ page }) => {
  if (!process.env.AL_HOLD) return;
  test.setTimeout(0);
  await page.pause();
});

// flowpad:capsule tag
// version: 1
// data:
//   tags:
//     breadcrumb.test.agent_session_persona.rules: FAILING? the auto-launched agent
//       must answer as itself, not as vibe - read this tag's rules (and its open item
//       on the vibe layer's capability pitch) before editing.
// flowpad:endcapsule tag
test('an auto-launched agent answers as itself, not as vibe', async ({ page }) => {
  test.setTimeout(180_000);

  await page.goto(`/dock/project/${projectId}`);

  // 1. Load-time redirect into the agent's session.
  await expect(page).toHaveURL(/\/dock\/shell\/agentic_process-[0-9a-f-]+/);
  const processId = /agentic_process-([0-9a-f-]{36})/.exec(page.url())![1];
  await expect(page.getByTestId('agent-intro-message')).toContainText('mail assistant');

  // 2. The user's first turn, through the real composer.
  const pane = page.getByTestId('flow-page');
  const composer = pane.getByTestId('entity-execution-input');
  await expect(composer).toBeEnabled();
  await composer.fill('hi, whats your job? who are you?');
  await composer.press('Enter');

  const reply = pane.locator('[data-testid="execution-message"][data-role="assistant"]').first();
  await expect(reply).not.toBeEmpty({ timeout: 120_000 });
  // The whole turn, not its first streamed chunk: the backend row says when it is done.
  await expect
    .poll(
      async () => {
        const r = (await (await fetch(`${GRAPH}/agentic_process/${processId}`)).json()).data;
        return !r.busy && r.worker_status === 'complete';
      },
      { timeout: 120_000 },
    )
    .toBe(true);

  // 3. Ground truth: the system prompt the worker was actually launched with.
  const row = await (await fetch(`${GRAPH}/agentic_process/${processId}`)).json();
  const claudeMd = path.join(row.data.exe_folder.path, 'assets', 'CLAUDE.md');
  const rendered = fs.readFileSync(claudeMd, 'utf-8');
  expect(rendered, 'the agent prompt must reach the worker').toContain(`You are ${AGENT_NAME}`);
  expect.soft(rendered, 'no competing persona may follow the agent prompt').not.toContain("# You are the 'vibe' agent");

  // 4. What the user sees: an email assistant, not vibe.
  await expect.soft(reply).toContainText(/inbox|e-?mail/i);
  await expect.soft(reply).not.toContainText(VIBE_PITCH);
});
