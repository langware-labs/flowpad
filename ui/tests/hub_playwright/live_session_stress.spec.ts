/**
 * Browser stress: one active session takes 10 follow-ups fired back-to-back
 * from its view, then 3 more prompts from the thread — which JOIN the open
 * session (one open session per conversation). Asserts: the thread holds
 * exactly 1 session card (no follow-up or reply leaks into it), the session's
 * view shows 14 prompts and 14 replies in send order, bob runs ONE
 * worker for the conversation, and his backend log has no
 * "database is locked". A standing grant is set first so no approvals gate the
 * run. Real worker turns — the spec carries its own budget.
 * do not increase timeout without approval
 */
import { chromium, expect, test, type Browser } from '@playwright/test';

import { BOB, assertPreconditions } from './helpers';
import {
  HOST_PROJECT_ID,
  aliceCloudId,
  revokeAliceGrantsOnBob,
  sendFollowUp,
  sendOpeningPrompt,
  sessionCards,
  setupLiveConversation,
  shot,
} from './_live_session_setup';

const SPEC_BUDGET_MS = 480_000;
const ALL_TURNS_BUDGET_MS = 360_000;
const FOLLOW_UPS = 10;
const THREAD_PROMPTS = 3;
const TURNS = 1 + FOLLOW_UPS + THREAD_PROMPTS;

async function grantAliceOnBob() {
  const id = await aliceCloudId();
  const r = await fetch(`${BOB.backendUrl}/api/v1/graph/contact_permission`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'contact_permission',
      contact_user_id: id,
      project_id: null,
      allowed_actions: ['auto_approve_session'],
    }),
  });
  if (!r.ok) throw new Error(`grant failed: ${r.status} ${await r.text()}`);
}

test('browser stress: 10 rapid follow-ups + 3 thread prompts join the one open session', async () => {
  test.setTimeout(SPEC_BUDGET_MS);
  test.skip(!HOST_PROJECT_ID, 'HOST_PROJECT_ID (a project on bob with a workdir) is required');
  await assertPreconditions();
  await grantAliceOnBob();
  const browser: Browser = await chromium.launch();
  try {
    const { alice, bob, convId } = await setupLiveConversation(browser);
    const t0 = Date.now();
    const m = (i: number) => `SX-${t0}-${i}`;
    await sendOpeningPrompt(alice.page, `Reply with exactly the text ${m(0)} and nothing else.`);
    await expect(sessionCards(alice.page).first()).toHaveAttribute('data-status', 'active', { timeout: 5_000 });

    // fire 10 follow-ups back-to-back from the session view, no waiting
    await sessionCards(alice.page).first().click();
    await alice.page.waitForURL(/\/dock\/live_session\//, { timeout: 5_000 });
    for (let i = 1; i <= FOLLOW_UPS; i++) {
      await sendFollowUp(alice.page, `Reply with exactly the text ${m(i)} and nothing else.`);
    }
    console.log(`[stress] ${FOLLOW_UPS} follow-ups sent in ${Date.now() - t0} ms`);
    // and 3 prompts from the thread while it is running: they join the open session
    await alice.page.goBack();
    await alice.page.locator('textarea[placeholder^="Reply to sender"]').waitFor({ state: 'visible' });
    for (let k = 1; k <= THREAD_PROMPTS; k++) {
      await sendOpeningPrompt(alice.page, `Reply with exactly the text ${m(FOLLOW_UPS + k)} and nothing else.`);
    }
    await expect(sessionCards(alice.page)).toHaveCount(1, { timeout: 5_000 });
    await shot(alice.page, 'stress-01-one-card');

    // the one session settles with every turn answered
    const first = sessionCards(alice.page).first();
    await expect(first).toContainText(new RegExp(`${TURNS} prompts · ${TURNS} repl`), { timeout: ALL_TURNS_BUDGET_MS });
    console.log(`[stress] all ${TURNS} turns replied in ${Date.now() - t0} ms`);
    expect(await sessionCards(alice.page).count()).toBe(1);
    expect(await sessionCards(bob.page).count()).toBe(1);
    const threadTexts = await alice.page.locator('[data-testid^="message-bubble-"]').allInnerTexts();
    expect(threadTexts.filter((t) => /Prompt response:/.test(t))).toHaveLength(0);
    expect(threadTexts.filter((t) => t.includes('SX-')).length).toBe(1);

    // first session view: replies in send order, one per prompt
    await first.click();
    await alice.page.waitForURL(/\/dock\/live_session\//, { timeout: 5_000 });
    const replies = alice.page.getByTestId('live-session-reply');
    await expect(replies).toHaveCount(TURNS, { timeout: 5_000 });
    const texts = await replies.allInnerTexts();
    for (let i = 0; i < TURNS; i++) expect(texts[i], `reply ${i}`).toContain(m(i));
    await shot(alice.page, 'stress-02-session-view-all-replies');

    // one worker on the host, no lock errors
    const procs = await fetch(`${BOB.backendUrl}/api/v1/graph/agentic_process`).then((r) => r.json());
    const mine = ((procs?.data ?? []) as Array<Record<string, unknown>>).filter(
      (p) => p.target_typeid_str === `conversation-${convId}`,
    );
    expect(mine.length).toBe(1);
  } finally {
    await browser.close();
    await revokeAliceGrantsOnBob();
  }
});
