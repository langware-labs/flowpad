/**
 * FLOWPAD-1640 — closing a chat opened from the home prompt must not make an
 * unauthenticated close/delete request.
 *
 * The old project-tab chat now routes through Home → Vibe workspace, but the
 * invariant is unchanged: close the resulting process tab through the real X
 * and inspect both network statuses and browser errors.
 */
import { expect, test } from '@playwright/test';
import { gotoLanding, submitFromLanding } from './helpers';

test('home prompt → close chat emits no 401', async ({ page }) => {
  const consoleErrors: string[] = [];
  const unauthorizedResponses: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('response', (response) => {
    if (response.status() === 401) {
      unauthorizedResponses.push(`${response.request().method()} ${response.url()}`);
    }
  });

  await page.addInitScript(() => {
    try {
      localStorage.setItem('llm-setup-modal-seen', 'true');
    } catch {
      /* sandboxed frame (mcp-ui): no storage, and nothing there needs the flag */
    }
  });
  // Home submissions open a Vibe tab. Its chip's X in the global strip is the
  // user-facing close path for its process tab.
  await gotoLanding(page, 'advanced');
  await submitFromLanding(page, 'hi');
  const chatUrl = page.url();
  expect(chatUrl).toMatch(/\/dock\/(shell|vibe)\/agentic_process-/);

  const chip = page.locator('[data-testid="terminal-tab-bar"] [data-testid^="tab-shell|agentic_process-"]').first();
  const close = chip.getByRole('button', { name: 'Close tab' });
  await expect(close).toBeVisible();
  await close.click();
  await expect(page).not.toHaveURL(chatUrl);

  expect(unauthorizedResponses).toEqual([]);
  expect(
    consoleErrors.filter((error) => /\b401\b|unauthorized/i.test(error)),
  ).toEqual([]);
});
