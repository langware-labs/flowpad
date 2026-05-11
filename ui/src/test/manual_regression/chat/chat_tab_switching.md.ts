import { test, expect } from '@playwright/test';
import { dismissSetupModal, gotoLanding, submitFromLanding, waitForLanding } from './helpers';

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
    // Dismiss WelcomeModal if shown (may reappear after navigating back to home with a clean DB)
    const skipForNow = page.getByRole('button', { name: 'Skip for now' });
    if (await skipForNow.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await skipForNow.click({ force: true }).catch(() => {});
      await page.waitForTimeout(500);
    }
    // Use CSS selector instead of getByRole to avoid aria-hidden issues when modal is present
    await waitForLanding(page);

    // Navigate to a new shell terminal
    await page.goto('/dock/shell/new_terminal');
    await expect(page).toHaveURL(/\/dock\/shell\//, { timeout: 60_000 });
  });
});
