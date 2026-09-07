/**
 * Browser scenario — project agent auto-launch + agent intro.
 *
 *   1. Seed a fresh project with TWO agents that set `auto_launch` (via the
 *      real authoring route, so `agent.md` lands under the project).
 *   2. Open the project in the browser: the dock loader's redirect must land
 *      in the Vibe workspace of the OLDEST agent's session, the intro row is
 *      the first thing in the pane, the auto-launch prompt is queued or already
 *      the first user turn, and the cancelled agent is named in a warning.
 *   3. Open the project again: no second launch — the URL stays on the project.
 *
 * Backend seeding uses the HTTP graph API directly.
 */
import { expect, test } from '@playwright/test';

const BE = `http://localhost:${process.env.AL_BE_PORT || '6001'}`;
const GRAPH = `${BE}/api/v1/graph`;
const PROMPT = 'Reply with exactly the words AUTO LAUNCH OK and nothing else.';

let projectId = '';
let firstAgentTitle = '';
let secondAgentTitle = '';

async function post(url: string, body: unknown): Promise<any> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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
  const created = await post(`${GRAPH}/project`, { type: 'project', name: `al-e2e-${stamp}` });
  projectId = created?.data?.id;
  if (!projectId) throw new Error(`project create failed: ${JSON.stringify(created).slice(0, 200)}`);

  // Saved FIRST → oldest → the one that launches. Names chosen so alphabetical
  // order would pick the OTHER one: the test pins age, not name order.
  firstAgentTitle = `Zed Greeter ${stamp}`;
  secondAgentTitle = `Abe Helper ${stamp}`;
  for (const title of [firstAgentTitle, secondAgentTitle]) {
    const res = await post(`${GRAPH}/project/${projectId}/agent`, {
      type: 'agent',
      name: title,
      title,
      intro: `Hello from ${title}. I will start by saying the magic words.`,
      auto_launch: true,
      auto_launch_prompt: PROMPT,
    });
    if (res?.status !== 'SUCCESS') throw new Error(`agent create failed: ${JSON.stringify(res).slice(0, 300)}`);
  }
});

test.afterAll(async () => {
  try {
    if (projectId) {
      await fetch(`${GRAPH}/project/${projectId}/delete-with-children`, {
        method: 'POST',
        signal: AbortSignal.timeout(20_000),
      });
    }
  } catch {
    /* best effort — the instance is disposable */
  }
});

test.beforeEach(async ({ page }) => {
  // Same harness-login-gate suppression as the context-folders scenario.
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  });
});

test('opening the project auto-launches the oldest agent once, with its intro and prompt', async ({ page }) => {
  await page.goto(`/dock/project/${projectId}`);

  // 1. Load-time redirect into the session, in Vibe.
  await expect(page).toHaveURL(/\/dock\/shell\/agentic_process-[0-9a-f-]+.*viewMode=vibe/);

  // 2. The intro row is the first thing in the pane, signed by the OLDEST agent.
  const intro = page.getByTestId('agent-intro-message');
  await expect(intro).toHaveCount(1);
  await expect(intro).toContainText(`Hello from ${firstAgentTitle}`);

  // 3. The prompt rode the queue: it is either still queued (chip) or already
  //    drained into the first user turn. Either proves delivery through the queue
  //    path rather than a direct first turn (the process was opened with `use()`).
  const queued = page.getByTestId('entity-execution-queue-entry').filter({ hasText: 'AUTO LAUNCH OK' });
  const userTurn = page.locator('[data-testid="execution-message"][data-role="user"]').filter({ hasText: 'AUTO LAUNCH OK' });
  await expect(queued.or(userTurn).first()).toBeVisible();

  // 4. The cancelled agent is named in the warning (forced toast).
  await expect(page.getByText(secondAgentTitle, { exact: false }).first()).toBeVisible();

  // 5. Backend agrees: both agents are marked, a second call has nothing to launch.
  const again = await post(`${BE}/api/v1/agents/auto-launch`, { project_id: projectId });
  expect(again?.data?.agent_id).toBeNull();
  const marks = await (await fetch(`${BE}/api/v1/agents/auto-launch?project_id=${projectId}`)).json();
  expect(marks?.data?.auto_launched_agent_ids?.length).toBe(2);
});

test('opening the project again does not launch a second session', async ({ page }) => {
  await page.goto(`/dock/project/${projectId}`);
  // The project view renders and the URL stays put: no redirect this time.
  await expect(page.getByText('Context folders', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/dock/project/${projectId}`));
});
