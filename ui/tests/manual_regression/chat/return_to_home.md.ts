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
    test.setTimeout(60_000);

    await gotoLanding(page);
    await submitFromLanding(page, 'return home test');

    // wait for shell terminal to open
    await expect(page).toHaveURL(/\/dock\/shell\//, { timeout: 45_000 });

    // click home button to navigate back to landing page
    await goHome(page);

    // validate landing page is visible
    // Use CSS selector instead of getByRole — a Radix AlertDialog sets aria-hidden on
    // the page behind it, causing getByRole('heading') to fail while one is open.
    await expect(page.locator('h1, h2, h3').filter({ hasText: /hey /i }).first()).toBeVisible();
    // `/dock/home` is the dock spelling of the app root; the loader redirects it
    // to the canonical `/` (load-dock-pointer.ts), so the root path is the
    // address the home landing settles on.
    expect(new URL(page.url()).pathname).toBe('/');

    // Validate the home session input is visible.
    // Home renders <SessionInput> inline as a textarea with
    // aria-label="What would you like to work on?".
    await expect(page.locator('textarea[aria-label="What would you like to work on?"]')).toBeVisible({ timeout: 10_000 });
  });
});
