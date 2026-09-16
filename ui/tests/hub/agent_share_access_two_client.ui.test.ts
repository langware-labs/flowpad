/**
 * The agent visibility panel's Share button actually GRANTS access — real
 * browser for the share, everything else via API.
 *
 * dev-1 (alice) owns a brand-new agent; dev-2 (bob) has no relationship to it
 * yet. The test proves the whole before/after:
 *   1. deny   — bob's own backend has no row for alice's agent (404)
 *   2. share  — alice clicks the new "Share with specific people" button in
 *               AgentPublicVisibilitySection and drives the real
 *               ShareToConversationDialog (Playwright), picking bob
 *   3. receive — bob syncs his assignment and maps the conversation to a
 *               project; the shared agent (a file-backed asset, packed the
 *               same generic way workflow/whiteboard/skill are —
 *               flow_message_bundle.py) then materializes on his own backend
 *               automatically, with no separate download/install click needed
 *               for a direct one-recipient share
 *   4. allow  — bob's backend now serves that exact agent id, and re-opening
 *               the SAME editor URL that 404'd in step 1 now actually mounts
 *
 * Setup (both users, the agent) is driven entirely through the backend API —
 * no browser involved until step 2, which is the one thing under test.
 *
 * Requires the explicit SHARE_INST_1/SHARE_INST_2 pair with live frontends and
 * the cycle-owned FLOWPAD_HUB_URL. Skips when the hub or instances aren't up:
 *   scripts/instance_ctl.sh launch hub-2 --hub http://localhost:8094
 *   scripts/instance_ctl.sh launch hub-3 --hub http://localhost:8094
 *   cd ui && FLOWPAD_HUB_URL=http://localhost:8094 SHARE_INST_1=hub-2 SHARE_INST_2=hub-3 \
 *     ALICE_EMAIL=hub-2@local.test ALICE_PW=hub-2-pw-1234 \
 *     BOB_EMAIL=hub-3@local.test BOB_PW=hub-3-pw-1234 \
 *     FLOW_INSTANCE=hub-2 npx vitest run --project hub agent_share_access
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { testEntityName } from '../_cleanup';
import { hubAvailable } from './_hub';
import {
  HUB_INST_1 as INST_1,
  HUB_INST_2 as INST_2,
  getInstance,
  instanceAvailable,
  type ResolvedInstance,
} from './_instances';
import {
  driveShareDialog,
  launchBrowser,
  mapConversationToProject,
  openAssignedConversationInUI,
  openInstancePage,
  type InstancePage,
} from './_browser';

let skipReason: string | null = null;
let alice: ResolvedInstance;
let bob: ResolvedInstance;
let browser: Browser;
let alicePage: InstancePage;
let bobPage: InstancePage;

const ts = Date.now();
const agentName = testEntityName('agent');
const convTitle = testEntityName('conv');
let agentId = '';
let convId = '';

beforeAll(async () => {
  const hub = await hubAvailable();
  if (!hub.ok) return void (skipReason = hub.reason ?? 'hub unreachable');
  if (!instanceAvailable(INST_1) || !instanceAvailable(INST_2)) {
    return void (skipReason = `launch ${INST_1} + ${INST_2} (with frontends) via scripts/instance_ctl.sh`);
  }
  alice = await getInstance(INST_1);
  bob = await getInstance(INST_2);
  browser = await launchBrowser();
  alicePage = await openInstancePage(browser, INST_1);
  bobPage = await openInstancePage(browser, INST_2);
}, 60_000);

afterAll(async () => {
  await browser?.close().catch(() => undefined);
  if (skipReason) return;

  // Full-purge the agent off BOTH machines (alice's original, bob's installed
  // copy shares the same id) and the conversation off alice (owner cascade).
  for (const inst of [alice, bob]) {
    if (!inst || !agentId) continue;
    await fetch(`${inst.apiUrl}/api/v1/graph/compute_node/@local/fs-records/agent/${agentId}`, {
      method: 'DELETE',
    }).catch(() => undefined);
  }
  if (alice && convId) {
    await fetch(`${alice.apiUrl}/api/v1/graph/conversation-delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_id: convId, mode: 'delete_for_all' }),
    }).catch(() => undefined);
  }
});

beforeEach((ctx: any) => {
  if (skipReason) {
    console.error(`[agent-share-access] SKIP: ${skipReason}`);
    ctx.skip();
  }
});

/** Resolve a just-created conversation by its unique title, on the sender's backend. */
async function conversationIdByTitle(inst: ResolvedInstance, title: string): Promise<string> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const rows = (await inst.sdk.Conversation.query(
      new inst.sdk.QueryRequest({ type: 'conversation', query: { title }, name: 'conversation by title (agent share)' }),
      true,
    ).catch(() => [])) as Array<{ id: string; title?: string }>;
    const hit = rows.find((c) => c.title === title);
    if (hit) return hit.id;
    if (Date.now() > deadline) throw new Error(`no conversation titled "${title}" on ${inst.name}`);
    await new Promise((res) => setTimeout(res, 500));
  }
}

describe('agent visibility panel Share button grants access', () => {
  it('0 setup — alice creates an agent bob has no relationship to', async () => {
    const created = await fetch(`${alice.apiUrl}/api/v1/graph/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: agentName }),
    }).then((r) => r.json());
    agentId = created?.data?.id;
    expect(agentId, JSON.stringify(created)).toBeTruthy();
  });

  it('1 deny — bob has no access to the agent yet', async () => {
    const resp = await fetch(`${bob.apiUrl}/api/v1/graph/agent/${agentId}`);
    expect(resp.status).toBe(404);
  });

  it('2 share — alice shares it with bob from the agent panel\'s Share button', async () => {
    await alicePage.page.goto(
      `${alicePage.feUrl}/dock/assets/editor/agent/typeid/agent-${agentId}?viewMode=advanced`,
      { waitUntil: 'domcontentloaded' },
    );
    await alicePage.page.getByTestId('agent-share-with-people').click({ timeout: 20_000 });
    await driveShareDialog(alicePage.page, {
      recipientEmail: bob.email,
      note: `sharing my agent ${ts}`,
      title: convTitle,
    });
    convId = await conversationIdByTitle(alice, convTitle);
    expect(convId).toBeTruthy();
  });

  it('3 receive — bob syncs the assignment; the shared agent materializes on his backend', async () => {
    await openAssignedConversationInUI(bobPage, convId);
    await mapConversationToProject(bobPage, convId);

    // Verified live (no chip click / staged-review round-trip needed here): once
    // the conversation is mapped to a project, a direct one-recipient share's
    // attached asset downloads and installs on its own.
    let resp: Response | null = null;
    const deadline = Date.now() + 22_000;
    while (Date.now() < deadline) {
      resp = await fetch(`${bob.apiUrl}/api/v1/graph/agent/${agentId}`);
      if (resp.status === 200) break;
      await bobPage.page.waitForTimeout(500);
    }
    expect(resp?.status).toBe(200);
  });

  it('4 allow — bob\'s own backend now serves the agent, and his editor opens it', async () => {
    const resp = await fetch(`${bob.apiUrl}/api/v1/graph/agent/${agentId}`);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body?.data?.id).toBe(agentId);
    expect(body?.data?.name).toBe(agentName);

    // Retry, for real, through the UI: the SAME URL that had nothing to show
    // bob in step 1 now mounts his own copy of the agent editor.
    await bobPage.page.goto(
      `${bobPage.feUrl}/dock/assets/editor/agent/typeid/agent-${agentId}?viewMode=advanced`,
      { waitUntil: 'domcontentloaded' },
    );
    await bobPage.page
      .locator('[data-testid="agent-definition-fields"]')
      .first()
      .waitFor({ state: 'attached', timeout: 15_000 });
  });
});
