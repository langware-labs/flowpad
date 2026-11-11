import { test, expect } from '@playwright/test';
import { adjusted } from './tests/adjustableTimeout';

const APP_URL = 'http://localhost:4097';

test.setTimeout(adjusted(120_000));

test('Start new chat from landing page', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  // The LLM-setup onboarding modal is its own flow, not what this covers.
  await page.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));

  // 1. The landing page: "Hey <name>" over the session input.
  await page.goto(`${APP_URL}/dock/home`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('h1, h2, h3').filter({ hasText: /hey /i }).first()).toBeVisible({ timeout: adjusted(60_000) });

  // 2. Home renders <SessionInput> as a textarea labelled by its placeholder.
  const input = page.locator('textarea[aria-label="What would you like to work on?"]');
  await expect(input).toBeVisible({ timeout: adjusted(15_000) });
  await input.fill('Hello, can you help me?');
  await input.press('Enter');

  // 3. A home prompt opens the new session as a Vibe host tab (docs/tab-management.md).
  await expect(page).toHaveURL(/\/dock\/vibe\/agentic_process-[0-9a-f-]+/, { timeout: adjusted(30_000) });

  // 4. The message sent is the session's first turn, shown in its chat.
  await expect(page.getByText('Hello, can you help me?').first()).toBeVisible({ timeout: adjusted(15_000) });
  console.log('Console errors:', consoleErrors.length, consoleErrors.slice(0, 5));
});
