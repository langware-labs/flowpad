import { test, expect } from '@playwright/test';
import {
  dismissSetupModal,
  gotoLanding,
  submitFromLanding,
  goHome,
} from './helpers';

test.describe('Return to Home', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('navigate back to home from active shell session', async ({ page }) => {
    test.setTimeout(180_000);

    await gotoLanding(page);
    await submitFromLanding(page, 'return home test');

    // wait for shell terminal to open
    await expect(page).toHaveURL(/\/dock\/shell\//, { timeout: 45_000 });

    // click home button to navigate back to landing page
    await goHome(page);

    // validate landing page is visible
    // Use CSS selector instead of getByRole — Radix UI AlertDialog sets aria-hidden on
    // the page behind it, causing getByRole('heading') to fail when WelcomeModal is open.
    await expect(page.locator('h1, h2, h3').filter({ hasText: /hey /i }).first()).toBeVisible();
    expect(page.url()).toMatch(/\/dock\/home/);

    // validate landing page session input trigger button is ready (new UI: input is hidden behind a button)
    // Use CSS text filter instead of getByRole to avoid aria-hidden issues from WelcomeModal.
    await expect(page.locator('button').filter({ hasText: /what would you like to work on today\?/i }).first()).toBeVisible();
  });
});
