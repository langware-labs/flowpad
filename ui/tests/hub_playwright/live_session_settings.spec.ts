/**
 * Live session settings, through two real UIs:
 *   - a follow-up typed in the session view runs and its reply lands ONLY there
 *     (the thread's bubble count does not move — rules 3 and 4);
 *   - switching the reply policy to "reviews" makes the next reply a host
 *     draft in bob's session view; sending it delivers it to alice;
 *   - ticking "always allow sessions from alice" on bob makes alice's NEXT
 *     session start approved without an Approve click.
 *
 * Preconditions as in live_session_flow.spec.ts. Real worker turns, so the
 * spec carries its own budget.
 * do not increase timeout without approval
 */
import { chromium, expect, test, type Browser } from '@playwright/test';

import { BOB, assertPreconditions } from './helpers';
import { HOST_PROJECT_ID, revokeAliceGrantsOnBob, sendFollowUp, sendOpeningPrompt, sessionCards, setupLiveConversation, shot } from './_live_session_setup';

const SPEC_BUDGET_MS = 240_000;
const TURN_BUDGET_MS = 60_000;

test('live session settings: follow-up, review policy, standing grant', async () => {
  test.setTimeout(SPEC_BUDGET_MS);
  test.skip(!HOST_PROJECT_ID, 'HOST_PROJECT_ID (a project on bob with a workdir) is required');
  await assertPreconditions();
  await revokeAliceGrantsOnBob(); // a stale grant would skip PENDING
  const browser: Browser = await chromium.launch();
  try {
    const { alice, bob, convId } = await setupLiveConversation(browser);
    const m1 = `S1-${Date.now()}`;
    await sendOpeningPrompt(alice.page, `Reply with exactly the text ${m1} and nothing else.`);
    const bobCard = sessionCards(bob.page).first();
    await expect(bobCard).toHaveAttribute('data-status', 'pending', { timeout: 3_000 });
    await bobCard.getByTestId('session-card-approve').click();
    await expect(sessionCards(alice.page).first()).toHaveAttribute('data-status', 'active', { timeout: 3_000 });
    await expect(sessionCards(alice.page).first()).toContainText(/1 repl/, { timeout: TURN_BUDGET_MS });
    await shot(alice.page, 'settings-01-alice-thread-after-first-reply');

    // ── follow-up lives in the session view only ───────────────────────────
    const threadBubblesBefore = await alice.page.locator('[data-testid^="message-bubble-"]').count();
    await sessionCards(alice.page).first().getByTestId('session-card-open').click();
    await alice.page.waitForURL(/\/dock\/live_session\//, { timeout: 5_000 });
    await expect(alice.page.getByTestId('live-session-reply')).toHaveCount(1, { timeout: 3_000 });
    const m2 = `S1B-${Date.now()}`;
    await sendFollowUp(alice.page, `Reply with exactly the text ${m2} and nothing else.`);
    await expect(alice.page.getByTestId('live-session-reply')).toHaveCount(2, { timeout: TURN_BUDGET_MS });
    await expect(alice.page.getByTestId('live-session-reply').nth(1)).toContainText(m2);
    await shot(alice.page, 'settings-02-alice-session-view-two-replies');
    await alice.page.goBack();
    await alice.page.locator('textarea[placeholder^="Reply to sender"]').waitFor({ state: 'visible' });
    await expect(sessionCards(alice.page).first()).toContainText(/2 prompts · 2 repl/, { timeout: 3_000 });
    expect(await alice.page.locator('[data-testid^="message-bubble-"]').count()).toBe(threadBubblesBefore);
    await expect(bob.page.locator('[data-testid^="message-bubble-"]')).toHaveCount(threadBubblesBefore, { timeout: 3_000 });

    // ── review policy: the host drafts, then sends from the session ────────
    await sessionCards(bob.page).first().getByTestId('session-card-open').click();
    await bob.page.waitForURL(/\/dock\/live_session\//, { timeout: 5_000 });
    await bob.page.getByTestId('live-session-reply-policy').click();
    await bob.page.getByRole('option', { name: /reviews/ }).click();
    await shot(bob.page, 'settings-03-bob-session-view-review-policy');
    await sessionCards(alice.page).first().getByTestId('session-card-open').click();
    await alice.page.waitForURL(/\/dock\/live_session\//, { timeout: 5_000 });
    await expect(alice.page.getByTestId('live-session-reply-policy')).toContainText(/reviews/, { timeout: 5_000 });
    const m3 = `S1C-${Date.now()}`;
    await sendFollowUp(alice.page, `Reply with exactly the text ${m3} and nothing else.`);
    const draft = bob.page.getByTestId('live-session-review-draft');
    await expect(draft).toHaveCount(1, { timeout: TURN_BUDGET_MS });
    await shot(bob.page, 'settings-04-bob-review-draft');
    await expect(alice.page.getByTestId('live-session-reply')).toHaveCount(2); // not delivered yet
    const draftSend = draft.locator('button[title="Send"]:not([data-testid])');
    await expect(draftSend).toBeEnabled({ timeout: 2_000 });
    await draftSend.click();
    await expect(alice.page.getByTestId('live-session-reply')).toHaveCount(3, { timeout: 10_000 });
    await expect(alice.page.getByTestId('live-session-reply').nth(2)).toContainText(m3);
    await shot(alice.page, 'settings-05-alice-reviewed-reply-delivered');

    // ── standing grant: alice's next session starts approved ───────────────
    await bob.page.getByTestId('live-session-standing-grant').click();
    await expect(bob.page.getByTestId('live-session-standing-grant')).toHaveAttribute('data-state', 'checked', { timeout: 3_000 });
    await alice.page.goBack();
    await alice.page.locator('textarea[placeholder^="Reply to sender"]').waitFor({ state: 'visible' });
    const m4 = `S2-${Date.now()}`;
    await sendOpeningPrompt(alice.page, `Reply with exactly the text ${m4} and nothing else.`);
    await expect(sessionCards(alice.page)).toHaveCount(2, { timeout: 3_000 });
    const second = sessionCards(alice.page).nth(1);
    await expect(second).toHaveAttribute('data-status', 'active', { timeout: 5_000 });
    const sessions = await fetch(`${BOB.backendUrl}/api/v1/graph/remote_worker_session`).then((r) => r.json());
    const mine = ((sessions?.data ?? []) as Array<Record<string, unknown>>).filter((s) => s.conversation_id === convId);
    expect(mine.map((s) => s.approved_via).sort()).toEqual(['manual', 'standing_grant']);
    await expect(second).toContainText(/1 repl/, { timeout: TURN_BUDGET_MS });
    await shot(alice.page, 'settings-06-alice-two-sessions-second-auto-approved');
    console.log('[settings] follow-up, review, standing grant: all verified');
  } finally {
    await browser.close();
    await revokeAliceGrantsOnBob(); // leave the host as we found it
  }
});
