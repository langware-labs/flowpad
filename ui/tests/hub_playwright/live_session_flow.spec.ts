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

import { assertPreconditions } from './helpers';
import { HOST_PROJECT_ID, sessionCards as sessionCard, sendOpeningPrompt, setupLiveConversation } from './_live_session_setup';

// Authored budget for a spec whose one slow leg is a real LLM turn.
// do not increase timeout without approval
const SPEC_BUDGET_MS = 90_000;
const TURN_BUDGET_MS = 60_000;

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
    // 1-2. conversation via the existing invitation flow, mapped on bob's side
    //      (the gate only runs project-mapped conversations), both threads open.
    const { alice, bob } = await setupLiveConversation(browser);

    // 3. alice opens a session from the composer
    const marker = `LIVE-${Date.now()}`;
    const promptText = `Reply with exactly the text ${marker} and nothing else.`;
    const tSent = Date.now();
    await sendOpeningPrompt(alice.page, promptText);

    await expect(sessionCard(alice.page).first()).toHaveAttribute('data-status', /pending|requesting/, { timeout: 2_000 });

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
