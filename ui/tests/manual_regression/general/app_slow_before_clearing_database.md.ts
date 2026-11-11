/**
 * The app remains navigable before any explicit database-clear operation.
 * Source: app_slow_before_clearing_database.md
 *
 * A multi-hour soak does not fit the fail-closed Playwright file gate. This
 * captures the regression's observable invariant instead: normal navigation
 * must stay interactive and must not rely on silently clearing user data.
 */
import { expect, test } from '@playwright/test';

test('core views remain interactive without a browser-triggered database clear', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  });

  const clearRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/desktop-db/clear')) clearRequests.push(request.url());
  });

  await page.goto('/dock/home');
  await expect(page.getByTestId('flow-page')).toBeVisible();

  await page.goto('/dock/ai-config');
  await expect(page.getByText('AI Configuration', { exact: true })).toBeVisible();

  await page.goto('/dock/credentials/environment');
  await expect(page.locator('[data-testid="credentials-view"], [data-testid="login-required"]').first()).toBeVisible();

  await page.goto('/dock/home');
  await expect(page.getByTestId('flow-page')).toBeVisible();
  expect(clearRequests).toHaveLength(0);
});
