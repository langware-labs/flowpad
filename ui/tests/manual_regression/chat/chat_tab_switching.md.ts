import { test, expect } from '@playwright/test';
import { dismissSetupModal, gotoLanding, submitFromLanding } from './helpers';

test.describe('Chat Tab Switching', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('switch between sidebar dock views', async ({ page }) => {
    test.setTimeout(180_000);

    await gotoLanding(page);
    await submitFromLanding(page, 'tab switching test');

    // We're now in a shell session at /dock/shell/...
    await expect(page).toHaveURL(/\/dock\/shell\//, { timeout: 45_000 });
    const shellUrl = page.url();
    expect(shellUrl).toMatch(/\/dock\/shell/);

    // Navigate back to home
    await page.goto('/dock/home');
    await expect(page).toHaveURL(/\/dock\/home/, { timeout: 10_000 });
    await expect(page.getByRole('heading', { name: /hey /i })).toBeVisible({ timeout: 90_000 });

    // Navigate to a new shell terminal
    await page.goto('/dock/shell/new_terminal');
    await expect(page).toHaveURL(/\/dock\/shell\//, { timeout: 60_000 });
  });
});
