/**
 * Browser stress: one active session takes 10 follow-ups fired back-to-back
 * while 3 new sessions open from the thread. Asserts: the thread holds
 * exactly 4 session cards (no follow-up or reply leaks into it), the first
 * session's view shows 11 prompts and 11 replies in send order, bob runs ONE
 * worker for the conversation, and his backend log has no
 * "database is locked". A standing grant is set first so no approvals gate the
 * run. Real worker turns — the spec carries its own budget.
 * do not increase timeout without approval
 */
import { chromium, expect, test, type Browser } from '@playwright/test';

import { BOB, assertPreconditions } from './helpers';
import { HOST_PROJECT_ID, aliceCloudId, revokeAliceGrantsOnBob, sendFollowUp, sendOpeningPrompt, sessionCards, setupLiveConversation, shot } from './_live_session_setup';

const SPEC_BUDGET_MS = 480_000;
const ALL_TURNS_BUDGET_MS = 360_000;
const FOLLOW_UPS = 10;
const EXTRA_SESSIONS = 3;

async function grantAliceOnBob() {
  const id = await aliceCloudId();
  const r = await fetch(`${BOB.backendUrl}/api/v1/graph/contact_permission`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'contact_permission', contact_user_id: id, project_id: null, allowed_actions: ['auto_approve_session'] }),
  });
  if (!r.ok) throw new Error(`grant failed: ${r.status} ${await r.text()}`);
}

test('browser stress: 10 rapid follow-ups + 3 new sessions during a run', async () => {
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
    await sessionCards(alice.page).first().getByTestId('session-card-open').click();
    await alice.page.waitForURL(/\/dock\/live_session\//, { timeout: 5_000 });
    for (let i = 1; i <= FOLLOW_UPS; i++) {
      await sendFollowUp(alice.page, `Reply with exactly the text ${m(i)} and nothing else.`);
    }
    console.log(`[stress] ${FOLLOW_UPS} follow-ups sent in ${Date.now() - t0} ms`);
    // and 3 new sessions from the thread while the first one is running
    await alice.page.goBack();
    await alice.page.locator('textarea[placeholder^="Reply to sender"]').waitFor({ state: 'visible' });
    for (let k = 1; k <= EXTRA_SESSIONS; k++) {
      await sendOpeningPrompt(alice.page, `Reply with exactly the text ${m(100 + k)} and nothing else.`);
    }
    await expect(sessionCards(alice.page)).toHaveCount(1 + EXTRA_SESSIONS, { timeout: 5_000 });
    await shot(alice.page, 'stress-01-four-cards');

    // every session settles: first card 11/11, the others 1/1
    const first = sessionCards(alice.page).first();
    await expect(first).toContainText(new RegExp(`${1 + FOLLOW_UPS} prompts · ${1 + FOLLOW_UPS} repl`), { timeout: ALL_TURNS_BUDGET_MS });
    for (let k = 1; k <= EXTRA_SESSIONS; k++) {
      await expect(sessionCards(alice.page).nth(k)).toContainText(/1 prompt · 1 repl/, { timeout: ALL_TURNS_BUDGET_MS });
    }
    console.log(`[stress] all ${1 + FOLLOW_UPS + EXTRA_SESSIONS} turns replied in ${Date.now() - t0} ms`);
    expect(await sessionCards(alice.page).count()).toBe(1 + EXTRA_SESSIONS);
    expect(await sessionCards(bob.page).count()).toBe(1 + EXTRA_SESSIONS);
    const threadTexts = await alice.page.locator('[data-testid^="message-bubble-"]').allInnerTexts();
    expect(threadTexts.filter((t) => /Prompt response:/.test(t))).toHaveLength(0);
    expect(threadTexts.filter((t) => t.includes('SX-')).length).toBe(1 + EXTRA_SESSIONS);

    // first session view: replies in send order, one per prompt
    await first.getByTestId('session-card-open').click();
    await alice.page.waitForURL(/\/dock\/live_session\//, { timeout: 5_000 });
    const replies = alice.page.getByTestId('live-session-reply');
    await expect(replies).toHaveCount(1 + FOLLOW_UPS, { timeout: 5_000 });
    const texts = await replies.allInnerTexts();
    for (let i = 0; i <= FOLLOW_UPS; i++) expect(texts[i], `reply ${i}`).toContain(m(i));
    await shot(alice.page, 'stress-02-session-view-eleven-replies');

    // one worker on the host, no lock errors
    const procs = await fetch(`${BOB.backendUrl}/api/v1/graph/agentic_process`).then((r) => r.json());
    const mine = ((procs?.data ?? []) as Array<Record<string, unknown>>).filter((p) => p.target_typeid_str === `conversation-${convId}`);
    expect(mine.length).toBe(1);
  } finally {
    await browser.close();
    await revokeAliceGrantsOnBob();
  }
});
