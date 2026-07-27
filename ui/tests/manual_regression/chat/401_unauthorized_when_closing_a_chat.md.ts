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

  await page.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));
  await gotoLanding(page);
  await submitFromLanding(page, 'hi');
  const chatUrl = page.url();
  expect(chatUrl).toContain('/dock/shell/agentic_process-');

  const close = page.getByRole('button', { name: 'Close tab' }).last();
  await expect(close).toBeVisible();
  await close.click();
  await expect(page).not.toHaveURL(chatUrl);

  expect(unauthorizedResponses).toEqual([]);
  expect(
    consoleErrors.filter((error) => /\b401\b|unauthorized/i.test(error)),
  ).toEqual([]);
});
