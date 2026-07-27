/**
 * FLOWPAD-1647 — a remount must hydrate every durable thinking segment, not
 * only the tail that arrived after the refresh.
 *
 * A deterministic transcript models the canonical state after the turn has
 * finished. The browser loads it, hard-refreshes the active chat, and proves
 * all earlier reasoning segments and the final answer remain rendered without
 * requiring a second refresh.
 */
import { expect, test } from '@playwright/test';

const SESSION = 'refresh-thinking';
const SEGMENTS = [
  'First, I am establishing the calculator requirements.',
  'Next, I am checking the component structure and operations.',
  'Finally, I am validating the result before presenting it.',
];

function responseBody() {
  const common = {
    session_id: SESSION,
    worker: 'codex',
    parent_id: null,
    is_sidechain: false,
    model: 'gpt-5',
  };
  return {
    ok: true,
    worker_type: 'codex',
    session_id: SESSION,
    path: `/tmp/rollout-${SESSION}.jsonl`,
    received: false,
    header: { name: 'Calculator build' },
    entries: [
      {
        ...common,
        kind: 'user_message',
        id: 'refresh-user',
        entry_id: 'refresh-user',
        timestamp: '2026-07-25T10:00:00.000Z',
        text: 'create a calculator webapp in react',
        role: 'user',
      },
      ...SEGMENTS.map((thinking, index) => ({
        ...common,
        kind: 'assistant_message',
        id: `refresh-thinking-${index}`,
        entry_id: `refresh-thinking-${index}`,
        timestamp: `2026-07-25T10:00:0${index + 1}.000Z`,
        text: index === SEGMENTS.length - 1 ? 'The calculator webapp is ready.' : '',
        thinking,
        phase: index === SEGMENTS.length - 1 ? 'final_answer' : 'commentary',
      })),
    ],
  };
}

test('refresh preserves all previous thinking segments and the final response', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
    localStorage.setItem('viewMode', 'advanced');
  });
  await page.route(`**/api/v1/workers/codex/${SESSION}/transcript`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(responseBody()),
    });
  });

  await page.goto(`/dock/lens/codex/transcript/${SESSION}?transcriptMode=chat`);
  for (const segment of SEGMENTS) {
    await expect(page.getByText(segment, { exact: true })).toBeVisible();
  }

  await page.reload();
  for (const segment of SEGMENTS) {
    await expect(page.getByText(segment, { exact: true })).toBeVisible();
  }
  await expect(page.getByText('The calculator webapp is ready.', { exact: true })).toBeVisible();
});
