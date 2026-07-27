/**
 * FLOWPAD-1639 — the first home message must acknowledge submission
 * immediately and enter the chat workspace while process creation continues.
 *
 * This deliberately asserts visible acknowledgement instead of widening a
 * navigation budget: Enter clears the controlled draft, createProcess is
 * issued, and the URL/UI move to the real Vibe chat.
 */
import { expect, test } from '@playwright/test';
import { gotoLanding } from './helpers';

test('first home message immediately acknowledges submit and opens chat', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));
  await gotoLanding(page);

  const prompt =
    "generate architecture documentation for a gym management application that allows to match trainers to users based on user's needs, trainer's abilities and available gym infrastructure";
  const input = page.locator('textarea[aria-label^="What would you like to work on"]');
  await input.fill(prompt);

  const createRequest = page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      request.url().includes('/api/v1/graph/compute_node/') &&
      request.url().includes('/createProcess'),
  );
  await input.press('Enter');

  await expect(input).toHaveValue('');
  await createRequest;
  await expect(page).toHaveURL(/\/dock\/shell\/agentic_process-/);
  await expect(page.locator('[data-testid="entity-execution-new"]:visible')).toBeVisible();
});
