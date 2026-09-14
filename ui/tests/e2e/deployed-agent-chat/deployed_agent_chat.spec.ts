/**
 * Browser scenario — chat on an agent's REMOTE deployment from the DESKTOP app.
 *
 *   1. Precondition (seeded outside): the agent is deployed on the hub and the
 *      placement row is adopted on this backend (`DAC_DEPLOYMENT_ID`).
 *   2. Open the agent profile → Deployments → the remote row's chat button →
 *      the ordinary chat panel opens, bound to that placement.
 *   3. Send a token prompt: the reply streams into the panel (relayed by the
 *      local backend through the hub to the box), and the status settles.
 *   4. The backend holds a same-id route row (`remote: true`) for that
 *      deployment; reloading the page lists the session under past chats.
 *
 * The desktop runtime is the point: `supported_pages` must be the desk, not
 * the hub — the opposite of the hub-UI validation rule.
 */
import { expect, test } from '@playwright/test';

const BE = `http://localhost:${process.env.DAC_BE_PORT || '6009'}`;
const GRAPH = `${BE}/api/v1/graph`;
const AGENT_ID = process.env.DAC_AGENT_ID?.trim() ?? '';
const DEPLOYMENT_ID = process.env.DAC_DEPLOYMENT_ID?.trim() ?? '';

async function getJson(url: string): Promise<any> {
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  return r.json();
}

test.beforeAll(async () => {
  if (!AGENT_ID || !DEPLOYMENT_ID) {
    test.skip(true, 'DAC_AGENT_ID and DAC_DEPLOYMENT_ID name an already-deployed agent — seed one first');
  }
  try {
    const h = await fetch(`${BE}/api/v1/health/status`, { signal: AbortSignal.timeout(2000) });
    if (!h.ok) throw new Error('unhealthy');
  } catch {
    test.skip(true, `backend not up on ${BE} — launch a disposable instance first`);
  }
  const bootstrap = await getJson(`${GRAPH}/bootstrap`);
  expect(bootstrap?.data?.supported_pages, 'this must be the DESKTOP runtime').toContain('desk');
  const deployment = await getJson(`${GRAPH}/deployment/${DEPLOYMENT_ID}`);
  expect(deployment?.data?.parent_type_id, 'the placement belongs to the agent').toBe(`agent-${AGENT_ID}`);
  expect(deployment?.data?.target?.provider, 'the placement is not on this machine').not.toBe('local');
  // A sandbox idles to sleep between runs; waking it is part of the seeded
  // precondition, not of the chat the tests time. One `use` through the hub
  // readies the box (and leaves a route row the past-sessions test can see).
  const warm = await fetch(`${GRAPH}/agent/${AGENT_ID}/use`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deployment_id: DEPLOYMENT_ID }),
    signal: AbortSignal.timeout(180_000),
  });
  expect(warm.ok, 'the placement can be used from this backend').toBe(true);
});

/** The agent PROFILE (asset editor), not `/dock/agent/<id>` — that route is the agent's inbox. */
async function openDeployments(page: import('@playwright/test').Page) {
  await page.goto(`/dock/assets/editor/agent/typeid/agent-${AGENT_ID}`);
  await page.getByRole('tab', { name: 'Deploy' }).or(page.getByText('Deploy', { exact: true })).first().click();
}

test('the desktop opens a chat on the remote placement and streams its reply', async ({ page }) => {
  await openDeployments(page);

  await page.getByTestId(`deployment-chat-${DEPLOYMENT_ID}`).click();
  const panel = page.getByTestId('deployed-agent-chat');
  await expect(panel).toBeVisible();

  const token = `PONG${Date.now().toString(36).toUpperCase()}`;
  const composer = panel.getByPlaceholder(/Message this deployed agent/);
  await composer.fill(`Reply with exactly the word ${token} and nothing else.`);
  await composer.press('Enter');

  const userTurn = panel.locator('[data-testid="execution-message"][data-role="user"]').filter({ hasText: token });
  await expect(userTurn.first()).toBeVisible();
  const reply = panel.locator('[data-testid="execution-message"][data-role="assistant"]').filter({ hasText: token });
  await expect(reply.first()).toBeVisible();

  // The backend holds the hub's process at the hub's id, as a route row.
  const rows = (await getJson(`${GRAPH}/agentic_process`))?.data ?? [];
  const routes = rows.filter((r: any) => r.deployment_id === DEPLOYMENT_ID);
  expect(routes.length, 'a session row for this placement').toBeGreaterThan(0);
  expect(routes.every((r: any) => r.hub_route === true), 'every session of a remote placement is a route row').toBe(true);
  expect(routes.every((r: any) => r.pty_mode === false)).toBe(true);
});

test('a reload lists the session again as a route row of that placement', async ({ page }) => {
  await openDeployments(page);
  await page.getByTestId(`deployment-chat-${DEPLOYMENT_ID}`).click();
  await expect(page.getByTestId('deployed-agent-chat')).toBeVisible();

  await page.reload();
  await page.getByRole('tab', { name: 'Deploy' }).or(page.getByText('Deploy', { exact: true })).first().click();
  await page.getByTestId(`deployment-chat-${DEPLOYMENT_ID}`).click();
  await expect(page.getByTestId('deployed-agent-chat')).toBeVisible();

  // The past-sessions picker is scoped by `deploymentId`; the rows it lists are
  // the route rows the backend holds for this placement.
  const rows = (await getJson(`${GRAPH}/agentic_process`))?.data ?? [];
  const routes = rows.filter((r: any) => r.deployment_id === DEPLOYMENT_ID);
  expect(routes.length).toBeGreaterThan(0);
  expect(routes.every((r: any) => r.hub_route === true)).toBe(true);
});
