/**
 * Live session, end to end through two real UIs and the local hub.
 *
 *   alice (GUEST)  ──prompt──▶  hub  ──▶  bob (HOST, project-mapped, real worker)
 *
 *   1. alice creates a conversation with bob (hub assigns his membership).
 *   2. bob's conversation is mapped to a project with a workdir (the same
 *      ``conv.project_id`` write his project picker performs) — the host gate
 *      only runs mapped conversations.
 *   3. alice toggles "Run on bob's machine", types a prompt, sends. Her thread
 *      shows the starting message with a session card at ``pending``.
 *   4. bob's thread shows the same card with Approve; he clicks it. Both cards
 *      flip to ``active``.
 *   5. bob's worker runs the turn; the reply lands in the session. Rule 4: the
 *      reply must NOT render as a bubble in either thread — only the card's
 *      reply count moves.
 *   6. alice opens the session from the card: the session view is titled by
 *      the prompt and shows exactly one reply row.
 *
 * Prereqs (fail fast with a reason): both backends up + cloud-logged-in +
 * hub bridges connected (``assertPreconditions``); ``HOST_PROJECT_ID`` set to a
 * project id on bob's backend whose workdir exists; bob has a working headless
 * worker. Skips with a reason when ``HOST_PROJECT_ID`` is missing.
 *
 * The turn is a real LLM call, so THIS spec carries its own budget (below);
 * the shared config's sub-second SLOs still apply to every UI leg.
 *
 * Run:
 *   ALICE_UI_URL=… BOB_UI_URL=… HOST_PROJECT_ID=… \
 *     npx playwright test --config ui/tests/hub_playwright/playwright.config.ts live_session_flow.spec.ts
 */
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';

import {
  ALICE,
  BOB,
  assertPreconditions,
  gotoConversation,
  gotoHome,
  openInstance,
  startConversationViaUi,
} from './helpers';

const BOB_EMAIL = process.env.BOB_CLOUD_EMAIL || 'bob@local.test';
const HOST_PROJECT_ID = process.env.HOST_PROJECT_ID || '';

// Authored budget for a spec whose one slow leg is a real LLM turn.
// do not increase timeout without approval
const SPEC_BUDGET_MS = 90_000;
const TURN_BUDGET_MS = 60_000;

/** The same write the host's project picker performs: ``conv.project_id = X; conv.save()``. */
async function mapHostConversation(convId: string) {
  const url = `${BOB.backendUrl}/api/v1/graph/conversation/${convId}`;
  let conv: Record<string, unknown> | null = null;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const r = await fetch(url);
    if (r.ok) {
      const body = (await r.json()) as { data?: Record<string, unknown> };
      if (body.data?.id) { conv = body.data; break; }
    }
    await new Promise((res) => setTimeout(res, 200));
  }
  if (!conv) throw new Error(`bob never materialized conversation ${convId}`);
  const r = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...conv, project_id: HOST_PROJECT_ID }),
  });
  if (!r.ok) throw new Error(`mapping bob's conversation failed: ${r.status} ${await r.text()}`);
}

function sessionCard(page: Page) {
  return page.locator('[data-testid="session-card"]');
}

async function expectNoSessionRowsInThread(page: Page, startingText: string) {
  // Rule 3 + 4: nothing of the session but its starting message is a thread row.
  const bubbles = page.locator('[data-testid^="message-bubble-"]');
  const texts = await bubbles.allInnerTexts();
  const replyRows = texts.filter((t) => /Prompt response:/i.test(t));
  expect(replyRows, `reply rendered in the thread: ${JSON.stringify(replyRows)}`).toHaveLength(0);
  expect(await page.locator('[data-testid="session-event-line"]').count()).toBe(0);
  expect(texts.some((t) => t.includes(startingText))).toBe(true);
}

test('live session: alice prompts → bob approves → reply only in the session view', async () => {
  test.setTimeout(SPEC_BUDGET_MS);
  test.skip(!HOST_PROJECT_ID, 'HOST_PROJECT_ID (a project on bob with a workdir) is required');
  await assertPreconditions();

  const browser: Browser = await chromium.launch();
  try {
    const alice = await openInstance(browser, ALICE);
    const bob = await openInstance(browser, BOB);

    // 1. conversation via the existing invitation flow
    await gotoHome(bob.page);
    // The hub assigns bob's membership directly (no pending invitation); his
    // backend materializes the conversation on fan-out — mapHostConversation
    // polls for that row before mapping it.
    const convId = await startConversationViaUi(alice.page, BOB_EMAIL, `live-setup-${Date.now()}`);

    // 2. host mapping — the gate only runs project-mapped conversations
    await mapHostConversation(convId);

    await gotoConversation(bob.page, convId);
    await gotoConversation(alice.page, convId);

    // 3. alice opens a session from the composer
    const marker = `LIVE-${Date.now()}`;
    const promptText = `Reply with exactly the text ${marker} and nothing else.`;
    await alice.page.getByTestId('composer-session-toggle').click();
    const textarea = alice.page.locator('textarea[placeholder^="Prompt to run on"]');
    await textarea.fill(promptText);
    const sendBtn = alice.page.locator('button[title="Send"]:not([data-testid])');
    await expect(sendBtn).toBeEnabled({ timeout: 1_000 });
    const tSent = Date.now();
    await sendBtn.click();

    try {
      await expect(sessionCard(alice.page).first()).toHaveAttribute('data-status', /pending|requesting/, { timeout: 2_000 });
    } catch (e) {
      // RCA dump: what did alice's page and backend hold when the card failed to show?
      const bubbles = await alice.page.locator('[data-testid^="message-bubble-"]').allInnerTexts();
      const anchors = await alice.page.locator('[data-testid="session-anchor"]').count();
      const sessions = await fetch(`${ALICE.backendUrl}/api/v1/graph/remote_worker_session`).then((r) => r.json()).catch(() => null);
      const mine = ((sessions?.data ?? []) as Array<Record<string, unknown>>).filter((x) => x.conversation_id === convId);
      const fms = await fetch(`${ALICE.backendUrl}/api/v1/graph/conversation/${convId}/messages`).then((r) => r.json()).catch(() => null);
      console.log('[rca] alice url:', alice.page.url(), 'convId:', convId);
      console.log('[rca] alice text:', (await alice.page.locator('body').innerText()).replace(/\n+/g, ' | ').slice(0, 500));
      console.log('[rca] alice bubbles:', JSON.stringify(bubbles).slice(0, 400));
      console.log('[rca] alice anchors:', anchors, 'sessions for conv:', JSON.stringify(mine.map((x) => [x.id, x.status, x.starting_message_id])));
      console.log('[rca] alice fms:', JSON.stringify(((fms?.data ?? []) as Array<Record<string, unknown>>).map((m) => [String(m.id).slice(0, 8), m.remote_worker_session_id, (m.attachment as unknown[] | undefined)?.length])));
      throw e;
    }

    // 4. bob sees the pending card and approves
    const bobCard = sessionCard(bob.page).first();
    await expect(bobCard).toHaveAttribute('data-status', 'pending', { timeout: 2_000 });
    const tPending = Date.now();
    console.log(`[live] bob saw the pending card (+${tPending - tSent} ms)`);
    await bobCard.getByTestId('session-card-approve').click();
    await expect(bobCard).toHaveAttribute('data-status', 'active', { timeout: 2_000 });
    await expect(sessionCard(alice.page).first()).toHaveAttribute('data-status', 'active', { timeout: 2_000 });
    const tActive = Date.now();
    console.log(`[live] both cards active (+${tActive - tPending} ms)`);

    // 5. the turn runs on bob; the reply count moves, the thread does not
    await expect(sessionCard(alice.page).first()).toContainText(/1 repl/, { timeout: TURN_BUDGET_MS });
    console.log(`[live] reply counted on alice's card (+${Date.now() - tActive} ms)`);
    await expectNoSessionRowsInThread(alice.page, promptText);
    await expectNoSessionRowsInThread(bob.page, promptText);

    // 6. the session view holds the exchange
    await sessionCard(alice.page).first().getByTestId('session-card-open').click();
    await alice.page.waitForURL(/\/dock\/live_session\/[0-9a-f-]+/, { timeout: 5_000 });
    await expect(alice.page.getByTestId('live-session-title')).toContainText(marker.slice(0, 8), { timeout: 2_000 });
    await expect(alice.page.getByTestId('live-session-reply')).toHaveCount(1, { timeout: 2_000 });
    await expect(alice.page.getByTestId('live-session-reply').first()).toContainText(marker);
  } finally {
    await browser.close();
  }
});
