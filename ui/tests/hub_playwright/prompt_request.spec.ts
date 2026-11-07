/** Prompt requests over the real hub, two users (alice = sender/guest, bob = runner/host).
 *
 * A plain prompt (`flow conversation send --prompt` — the sender's own backend
 * `add_message {prompt_text}`) opens a one-prompt session shown as a
 * "Prompt request" row: bob answers Run & Update / Run / Decline, alice can Cancel,
 * and bob's machine ends the session once the prompt is answered. A live session
 * (the composer's live-session button) is unchanged and is never joined by, nor
 * turned into, a prompt request.
 *
 * Run (both instances up, cloud-logged-in to the local hub, bob's conversation
 * project-mapped via HOST_PROJECT_ID):
 *   npx playwright test --config ui/tests/hub_playwright/playwright.config.ts prompt_request
 */
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';

import { ALICE, BOB, assertPreconditions } from './helpers';
import { HOST_PROJECT_ID, revokeAliceGrantsOnBob, sendOpeningPrompt, sessionCards, setupLiveConversation, shot } from './_live_session_setup';

const SPEC_BUDGET_MS = 120_000;
const TURN_BUDGET_MS = 60_000; // a real Claude turn on bob's machine

async function sendPrompt(convId: string, text: string, prompt: string) {
  const r = await fetch(`${ALICE.backendUrl}/api/v1/graph/conversation/${convId}/add_message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, prompt_text: prompt }),
  });
  const body = (await r.json()) as { status: string; data?: { remote_worker_session_id?: string } };
  if (body.status !== 'SUCCESS') throw new Error(`prompt send failed: ${JSON.stringify(body)}`);
  return body.data?.remote_worker_session_id ?? '';
}

async function sessionRow(backendUrl: string, id: string) {
  const r = await fetch(`${backendUrl}/api/v1/graph/remote_worker_session/${id}`);
  return ((await r.json()) as { data?: Record<string, unknown> }).data ?? null;
}

function row(page: Page, sid: string) {
  return page.locator(`[data-testid="session-card"][data-session-id="${sid}"]`);
}

/** The row plus what renders under it (the update line / the update itself). */
function anchor(page: Page, sid: string) {
  return page.locator('[data-testid="session-anchor"]', { has: row(page, sid) });
}

/** Ground truth from bob's backend, not the UI: the host owns the session. */
async function expectEnded(sid: string, used: number) {
  await expect
    .poll(async () => {
      const s = await sessionRow(BOB.backendUrl, sid);
      return s ? `${s.status}/${s.prompts_used}` : 'none';
    }, { timeout: TURN_BUDGET_MS })
    .toBe(`ended/${used}`);
}

test.describe.configure({ mode: 'serial' });

let browser: Browser;
test.beforeAll(async () => {
  await assertPreconditions();
  await revokeAliceGrantsOnBob(); // a request must PARK for bob's answer
  browser = await chromium.launch();
});
test.afterAll(async () => browser?.close());

test('Run & Update: bob runs it, alice gets the update, the session ends', async () => {
  test.setTimeout(SPEC_BUDGET_MS);
  test.skip(!HOST_PROJECT_ID, 'HOST_PROJECT_ID is required');
  const { alice, bob, convId } = await setupLiveConversation(browser);
  const token = `PR-UPD-${Date.now()}`;
  const sid = await sendPrompt(convId, 'Run this when you can.', `Reply with exactly the text ${token} and nothing else.`);

  await expect(row(alice.page, sid)).toHaveAttribute('data-kind', 'prompt-request', { timeout: 10_000 });
  await expect(row(alice.page, sid).getByTestId('session-card-name')).toHaveText('Prompt request · prb-2');
  await expect(row(alice.page, sid).getByTestId('session-card-status')).toHaveText(/waiting for/);
  await expect(alice.page.getByText('Run this when you can.')).toBeVisible(); // the sender's text stays
  await expect(row(bob.page, sid).getByTestId('session-card-run-update')).toBeVisible({ timeout: 10_000 });
  await expect(row(bob.page, sid).getByTestId('session-card-run')).toBeVisible();
  await expect(row(bob.page, sid).getByTestId('session-card-decline')).toBeVisible();
  await expect(bob.page.getByText('Needs your approval')).toHaveCount(0);
  await shot(bob.page, 'pr-01-bob-request');

  await row(bob.page, sid).getByTestId('session-card-run-update').click();
  await expectEnded(sid, 1);
  await expect(anchor(alice.page, sid).getByTestId('session-card-update')).toContainText(token, { timeout: 15_000 });
  await expect(row(alice.page, sid)).toHaveAttribute('data-status', 'done');
  await expect(anchor(bob.page, sid).getByTestId('session-card-update-sent')).toBeVisible({ timeout: 10_000 });
  await shot(alice.page, 'pr-02-alice-update');
  expect((await sessionRow(BOB.backendUrl, sid))?.reply_policy).toBe('auto');
});

test('Run: bob runs it, nothing goes back, the session ends', async () => {
  test.setTimeout(SPEC_BUDGET_MS);
  test.skip(!HOST_PROJECT_ID, 'HOST_PROJECT_ID is required');
  const { alice, bob, convId } = await setupLiveConversation(browser);
  const sid = await sendPrompt(convId, 'Local only.', 'Reply with exactly the text PR-RUN and nothing else.');
  await row(bob.page, sid).getByTestId('session-card-run').click({ timeout: 10_000 });
  await expectEnded(sid, 1);
  expect((await sessionRow(BOB.backendUrl, sid))?.reply_policy).toBe('review');
  await expect(row(bob.page, sid)).toHaveAttribute('data-status', 'done', { timeout: 10_000 });
  await expect(anchor(bob.page, sid).getByTestId('session-card-update-sent')).toHaveCount(0);
  await expect(anchor(alice.page, sid).getByTestId('session-card-update')).toHaveCount(0);
});

test('Decline and Cancel: no run, both sides agree', async () => {
  test.setTimeout(SPEC_BUDGET_MS);
  test.skip(!HOST_PROJECT_ID, 'HOST_PROJECT_ID is required');
  const { alice, bob, convId } = await setupLiveConversation(browser);
  const declined = await sendPrompt(convId, 'Decline me.', 'echo nope');
  await row(bob.page, declined).getByTestId('session-card-decline').click({ timeout: 10_000 });
  await expect(row(alice.page, declined)).toHaveAttribute('data-status', 'declined', { timeout: 10_000 });

  const cancelled = await sendPrompt(convId, 'Cancel me.', 'echo nope');
  await expect(row(bob.page, cancelled).getByTestId('session-card-run')).toBeVisible({ timeout: 10_000 });
  await row(alice.page, cancelled).getByTestId('session-card-disconnect').click();
  await expect(row(bob.page, cancelled)).toHaveAttribute('data-status', 'ended', { timeout: 10_000 });
  await expect(row(bob.page, cancelled).getByTestId('session-card-run')).toHaveCount(0);
  for (const sid of [declined, cancelled]) expect((await sessionRow(BOB.backendUrl, sid))?.prompts_used ?? 0).toBe(0);
});

test('back-to-back prompts are separate requests; a live session stays live and takes the next prompt', async () => {
  test.setTimeout(SPEC_BUDGET_MS * 2);
  test.skip(!HOST_PROJECT_ID, 'HOST_PROJECT_ID is required');
  const { alice, bob, convId } = await setupLiveConversation(browser);
  const a = await sendPrompt(convId, 'First.', 'Reply with exactly the text PR-A and nothing else.');
  const b = await sendPrompt(convId, 'Second.', 'Reply with exactly the text PR-B and nothing else.');
  expect(a).not.toBe(b); // one approval never covers the next prompt
  await row(bob.page, a).getByTestId('session-card-run-update').click({ timeout: 10_000 });
  await row(bob.page, b).getByTestId('session-card-run-update').click({ timeout: 10_000 });
  await expectEnded(a, 1);
  await expectEnded(b, 1);

  // a live session opened on purpose: unlimited, and a plain prompt joins it
  await sendOpeningPrompt(alice.page, 'Reply with exactly the text LIVE-1 and nothing else.');
  const live = sessionCards(alice.page).filter({ hasNotText: 'Prompt request' }).first();
  await expect(live).toBeVisible({ timeout: 10_000 });
  const liveId = (await live.getAttribute('data-session-id')) ?? '';
  await row(bob.page, liveId).getByTestId('session-card-approve').click({ timeout: 10_000 });
  const joined = await sendPrompt(convId, 'Into the live one.', 'Reply with exactly the text LIVE-2 and nothing else.');
  expect(joined).toBe(liveId);
  await expect
    .poll(async () => (await sessionRow(BOB.backendUrl, liveId))?.prompts_used, { timeout: TURN_BUDGET_MS * 2 })
    .toBe(2);
  const s = await sessionRow(BOB.backendUrl, liveId);
  expect(s?.status).not.toBe('ended');
  expect(s?.prompt_limit ?? null).toBeNull();
  await shot(bob.page, 'pr-03-bob-mixed');
});
