/**
 * Browser scenario — chat with an agent's CLOUD placement through its `chat` endpoint.
 *
 * Precondition (seeded outside — a deploy is a real box, never a test's job): the
 * agent is deployed on a hub, and this desktop instance holds the placement
 * (`DAC_DEPLOYMENT_ID`) and its endpoints. Two surfaces, one endpoint:
 *
 *   1. DESKTOP (`DAC_FE_PORT`/`DAC_BE_PORT`): the agent profile, the cloud place's
 *      chat panel — the turn goes desktop → hub → box and its reply streams back;
 *      a reload shows the conversation as it stands.
 *   2. HUB UI (`DAC_HUB_FE_PORT`, a hub-mode dev UI on the hub `DAC_HUB_URL`): the
 *      owner, signed in by the test through the hub's login API
 *      (`DAC_HUB_EMAIL`/`DAC_HUB_PASSWORD`, a seeded test user), selects the agent
 *      in the WorldView and chats with the same placement from the hub itself.
 *
 * The token in each prompt is what proves a model read it: an echo of the
 * question would carry it too, so the assistant's own message is matched.
 */
import { expect, type Page, test } from '@playwright/test';

const BE = `http://localhost:${process.env.DAC_BE_PORT || '6009'}`;
const FE = `http://localhost:${process.env.DAC_FE_PORT || '5009'}`;
const HUB = process.env.DAC_HUB_URL?.trim() || 'http://localhost:8093';
const HUB_FE = `http://localhost:${process.env.DAC_HUB_FE_PORT || '4098'}`;
const AGENT_ID = process.env.DAC_AGENT_ID?.trim() ?? '';
const DEPLOYMENT_ID = process.env.DAC_DEPLOYMENT_ID?.trim() ?? '';
const HUB_EMAIL = process.env.DAC_HUB_EMAIL?.trim() ?? '';
const HUB_PASSWORD = process.env.DAC_HUB_PASSWORD ?? '';

async function getJson(url: string): Promise<any> {
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  return r.json();
}

/** The agent profile with the cloud place's chat open — a URL, like every dock state. */
function chatUrl(base: string): string {
  return `${base}/dock/assets/editor/agent/typeid/agent-${AGENT_ID}?place=${DEPLOYMENT_ID}&chat=${DEPLOYMENT_ID}`;
}

/** Send one token prompt in the open panel; the assistant's reply carries the token. */
async function chatOnce(page: Page): Promise<string> {
  const panel = page.getByTestId('deployed-agent-chat');
  await expect(panel).toBeVisible();
  const token = `PONG${Date.now().toString(36).toUpperCase()}`;
  const composer = panel.getByTestId('deployed-agent-chat-input');
  await expect(composer).toBeEnabled();
  await composer.fill(`Reply with exactly the word ${token} and nothing else.`);
  await composer.press('Enter');
  await expect(panel.getByTestId('deployed-agent-chat-user').filter({ hasText: token })).toBeVisible();
  await expect(panel.getByTestId('deployed-agent-chat-assistant').filter({ hasText: token })).toBeVisible();
  await expect(panel.getByTestId('deployed-agent-chat-error')).toHaveCount(0);
  return token;
}

test.describe('desktop', () => {
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
    const bootstrap = await getJson(`${BE}/api/v1/graph/bootstrap`);
    expect(bootstrap?.data?.supported_pages, 'this must be the DESKTOP runtime').toContain('desk');
    const deployment = await getJson(`${BE}/api/v1/graph/deployment/${DEPLOYMENT_ID}`);
    expect(deployment?.data?.parent_type_id, 'the placement belongs to the agent').toBe(`agent-${AGENT_ID}`);
    expect(deployment?.data?.target?.provider, 'the placement is not on this machine').not.toBe('local');
  });

  test('the cloud place chat streams the agent reply through the hub', async ({ page }) => {
    await page.goto(chatUrl(FE));
    await chatOnce(page);
  });

  test('a reload shows the conversation as it stands', async ({ page }) => {
    await page.goto(chatUrl(FE));
    const token = await chatOnce(page);
    await page.reload();
    const panel = page.getByTestId('deployed-agent-chat');
    await expect(panel.getByTestId('deployed-agent-chat-assistant').filter({ hasText: token })).toBeVisible();
  });
});

test.describe('hub UI', () => {
  test.beforeAll(async () => {
    if (!AGENT_ID || !DEPLOYMENT_ID || !HUB_EMAIL || !HUB_PASSWORD) {
      test.skip(true, 'DAC_HUB_EMAIL / DAC_HUB_PASSWORD name the seeded owner on the hub');
    }
    const bootstrap = await getJson(`${HUB}/api/v1/graph/bootstrap`);
    expect(bootstrap?.data?.supported_pages, 'this must be the HUB runtime').toEqual(['hub']);
  });

  test('the owner chats with the placement from the hub itself', async ({ page }) => {
    // Signed in through the hub's login API — through the dev UI's proxy, so the
    // session cookie is the browser's for this origin.
    const login = await page.request.post(`${HUB_FE}/api/v1/login`, {
      data: { email: HUB_EMAIL, password: HUB_PASSWORD },
    });
    expect(login.ok(), 'the seeded owner signs in').toBe(true);
    // The hub's surface for an agent is the WorldView: the agent node, selected, lists its
    // placements with a chat control each (the desktop's agent editor is not a hub page).
    const agent = `agent-${AGENT_ID}`;
    await page.goto(`${HUB_FE}/dock/hub/worldview/world?focus=${agent}&selected=${agent}`);
    await expect(page, 'the hub UI, not its login page').not.toHaveURL(/login\.html/);
    await page.getByTestId('worldview-agent-deployments').getByTestId(`deployment-chat-${DEPLOYMENT_ID}`).click();
    await chatOnce(page);
  });
});
