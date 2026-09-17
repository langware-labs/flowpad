/**
 * The agent visibility panel's Share button grants a HUB role on the agent —
 * real browser for the share, everything else via API.
 *
 * alice (INST_1) owns an agent that is on the hub; bob (INST_2) has no
 * relationship to it. The before/after:
 *   1. deny  — bob cannot read the agent on the hub
 *   2. share — alice clicks Share in AgentVisibilitySection, invites bob's email
 *              in ShareAgentDialog (Playwright) → `POST agent/<id>/members`
 *   3. allow — bob reads the same agent on the hub, holding `reader`
 *
 * Setup stands in for a real publish: `publish_git_asset` needs a connected
 * GitHub account and a github.com origin, which a local-hub run can't have.
 * Instead alice registers the agent on the hub under the same id and her local
 * row is marked published (`remote` + a git origin) — the two facts the panel
 * gates Share on and the invite's hub reflection needs.
 *
 *   scripts/instance_ctl.sh launch hub-2 --hub http://localhost:8094
 *   scripts/instance_ctl.sh launch hub-3 --hub http://localhost:8094
 *   cd ui && FLOWPAD_HUB_URL=http://localhost:8094 SHARE_INST_1=hub-2 SHARE_INST_2=hub-3 \
 *     ALICE_EMAIL=hub-2@local.test ALICE_PW=hub-2-pw-1234 \
 *     BOB_EMAIL=hub-3@local.test BOB_PW=hub-3-pw-1234 \
 *     FLOW_INSTANCE=hub-2 npx vitest run --project hub agent_share_access
 * Skips when the hub or instances aren't up.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { testEntityName } from '../_cleanup';
import { HUB_URL, hubAvailable, hubJson, hubLogin } from './_hub';
import { pollUntil } from './_matrix';
import {
  HUB_INST_1 as INST_1,
  HUB_INST_2 as INST_2,
  instanceAvailable,
  jsonApi,
  resolveLaunchedInstance,
  type LaunchedInstance,
} from './_instances';
import { launchBrowser, openInstancePage, type InstancePage } from './_browser';

let skipReason: string | null = null;
let alice: LaunchedInstance;
let bob: LaunchedInstance;
let aliceToken = '';
let bobToken = '';
let browser: Browser;
let alicePage: InstancePage;

const agentName = testEntityName('agent');
let agentId = '';

/** A git origin shaped like a real publish receipt — what `version.published` reads. */
const publishedOrigin = () => ({
  kind: 'git',
  provider: 'github',
  owner: 'e2e',
  name: 'agents',
  branch: 'flow-cloud',
  head_commit: 'e2e0000000000000000000000000000000000000',
  rel_path: `agentic-assets/agent/${agentName}`,
});

/** bob's view of the agent on the hub: status + his roles on it. */
async function bobHubRead(): Promise<{ status: number; roles: string[] }> {
  const r = await fetch(`${HUB_URL}/api/v1/graph/agent/${agentId}?expand=permissions`, {
    headers: { Authorization: `Bearer ${bobToken}` },
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, roles: body?.data?.expand?.roles ?? [] };
}

beforeAll(async () => {
  const hub = await hubAvailable();
  if (!hub.ok) return void (skipReason = hub.reason ?? 'hub unreachable');
  if (!instanceAvailable(INST_1) || !instanceAvailable(INST_2)) {
    return void (skipReason = `launch ${INST_1} + ${INST_2} (with frontends) via scripts/instance_ctl.sh`);
  }
  alice = resolveLaunchedInstance(INST_1)!;
  bob = resolveLaunchedInstance(INST_2)!;
  aliceToken = (await hubLogin(alice.email, alice.env.FLOWPAD_CLOUD_USER_PASSWORD)).token;
  bobToken = (await hubLogin(bob.email, bob.env.FLOWPAD_CLOUD_USER_PASSWORD)).token;
  browser = await launchBrowser();
  alicePage = await openInstancePage(browser, INST_1);
}, 60_000);

afterAll(async () => {
  await browser?.close().catch(() => undefined);
  if (skipReason || !agentId) return;
  await hubJson(aliceToken, `/graph/agent/${agentId}`, undefined, 'DELETE').catch(() => undefined);
  await fetch(`${alice.apiUrl}/api/v1/graph/compute_node/@local/fs-records/agent/${agentId}`, {
    method: 'DELETE',
  }).catch(() => undefined);
});

beforeEach((ctx: any) => {
  if (skipReason) {
    console.error(`[agent-share-access] SKIP: ${skipReason}`);
    ctx.skip();
  }
});

describe('agent visibility panel Share button grants a hub role', () => {
  it('0 setup — alice has a published agent bob has no relationship to', async () => {
    const created = await jsonApi(alice.apiUrl, '/graph/agent', 'POST', { name: agentName });
    agentId = created?.data?.id;
    expect(agentId, JSON.stringify(created)).toBeTruthy();

    await hubJson(aliceToken, '/graph/agent', { id: agentId, name: agentName });

    const marked = await jsonApi(alice.apiUrl, `/graph/agent/${agentId}`, 'PUT', {
      remote: true,
      origin: publishedOrigin(),
    });
    expect(marked?.status, JSON.stringify(marked)).toBe('SUCCESS');

    // The panel gates Share on this exact read.
    await pollUntil(
      async () => (await jsonApi(alice.apiUrl, `/graph/agent/${agentId}/version`))?.data?.published === true,
      10_000,
      'local agent reads as published',
    );
  });

  it('1 deny — bob cannot read the agent on the hub', async () => {
    const { status } = await bobHubRead();
    expect([403, 404]).toContain(status);
  });

  it("2 share — alice invites bob from the agent panel's Share button", async () => {
    const { page, feUrl } = alicePage;
    await page.goto(`${feUrl}/dock/assets/editor/agent/typeid/agent-${agentId}?viewMode=advanced`, {
      waitUntil: 'domcontentloaded',
    });
    const share = page.getByTestId('agent-share-with-people');
    await share.waitFor({ state: 'visible', timeout: 20_000 });
    await expect.poll(() => share.isEnabled(), { timeout: 15_000 }).toBe(true);
    await share.click();

    const dialog = page.getByTestId('share-agent-dialog');
    await dialog.waitFor({ state: 'visible', timeout: 10_000 });
    // The testid is on the picker's <input>. The dialog's open animation and focus
    // trap swallow early keystrokes — click, settle, type, verify the value landed.
    const contact = dialog.getByTestId('share-agent-input');
    await contact.click();
    await page.waitForTimeout(500);
    await contact.pressSequentially(bob.email, { delay: 15 });
    if ((await contact.inputValue()) !== bob.email) await contact.fill(bob.email);
    await contact.press('Enter');

    await dialog.getByTestId('share-agent-submit').click();
    // The dialog closes only when every address was granted; a failure stays open and names it.
    await dialog.waitFor({ state: 'detached', timeout: 25_000 }).catch(async () => {
      const alert = await dialog.getByRole('alert').textContent().catch(() => '');
      throw new Error(`share dialog did not close: ${alert || '(no error shown)'}`);
    });
  });

  it('3 allow — bob reads the same agent on the hub, as reader', async () => {
    const seen = await pollUntil(async () => {
      const read = await bobHubRead();
      return read.status === 200 ? read : null;
    }, 15_000, 'bob can read the agent on the hub');
    expect(seen.roles).toContain('reader');
  });
});
