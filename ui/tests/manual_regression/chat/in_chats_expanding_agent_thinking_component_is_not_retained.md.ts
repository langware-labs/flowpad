/**
 * FLOWPAD-1641 — expanded thinking state belongs to its open chat tab.
 *
 * Deterministic parsed transcripts keep this browser test independent of a
 * live model. Both chats are opened through production URL-first navigation;
 * returning via the first tab must restore its expanded thinking block.
 */
import { expect, test, type Page, type Route } from '@playwright/test';

const LONG_THINKING =
  'I am comparing the request with the project context.\n' +
  'I will inspect the durable state before deciding what to change.\n' +
  'The relevant constraints must remain visible when this chat is revisited.\n' +
  'This final line makes the reasoning block long enough to expose its expansion control. '.repeat(3);

function transcript(sessionId: string, name: string) {
  const common = {
    session_id: sessionId,
    worker: 'codex',
    parent_id: null,
    is_sidechain: false,
    model: 'gpt-5',
  };
  return {
    ok: true,
    worker_type: 'codex',
    session_id: sessionId,
    path: `/tmp/rollout-${sessionId}.jsonl`,
    received: false,
    header: { name },
    entries: [
      {
        ...common,
        kind: 'user_message',
        id: `${sessionId}-user`,
        entry_id: `${sessionId}-user`,
        timestamp: '2026-07-25T10:00:00.000Z',
        text: 'hi',
        role: 'user',
      },
      {
        ...common,
        kind: 'assistant_message',
        id: `${sessionId}-assistant`,
        entry_id: `${sessionId}-assistant`,
        timestamp: '2026-07-25T10:00:01.000Z',
        text: `response from ${name}`,
        thinking: LONG_THINKING,
        phase: 'final_answer',
      },
    ],
  };
}

async function fulfillTranscript(route: Route) {
  const match = route.request().url().match(/\/codex\/([^/]+)\/transcript/);
  const sessionId = match?.[1] ?? 'unknown';
  const name = sessionId === 'thinking-one' ? 'Thinking chat one' : 'Thinking chat two';
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(transcript(sessionId, name)),
  });
}

async function forceAdvanced(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
    localStorage.setItem('viewMode', 'advanced');
  });
}

test('thinking expansion is retained when switching between two chat tabs', async ({ page }) => {
  await forceAdvanced(page);
  await page.route('**/api/v1/workers/codex/*/transcript', fulfillTranscript);
  await page.goto('/dock/lens/codex/transcript/thinking-one?transcriptMode=chat');

  const thinking = page.getByText(LONG_THINKING, { exact: true });
  await expect(thinking).toBeVisible();
  await page.getByRole('button', { name: 'Show more' }).click();
  await expect(page.getByRole('button', { name: 'Show less' })).toBeVisible();

  await page.evaluate(() => {
    (window as unknown as {
      navigation: { openLens: (category: string, type: string, ref: string) => void };
    }).navigation.openLens('codex', 'transcript', 'thinking-two');
  });
  await expect(page).toHaveURL(/thinking-two/);
  await expect(page.getByText('response from Thinking chat two', { exact: true })).toBeVisible();

  await page.locator('[data-testid*="thinking-one"]').first().click();
  await expect(page).toHaveURL(/thinking-one/);
  await expect(page.getByRole('button', { name: 'Show less' })).toBeVisible();
});
