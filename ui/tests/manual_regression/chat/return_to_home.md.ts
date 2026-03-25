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
    await expect(page.getByRole('heading', { name: /hey /i })).toBeVisible();
    expect(page.url()).toMatch(/\/dock\/home/);

    // validate landing page session input trigger button is ready (new UI: input is hidden behind a button)
    await expect(page.getByRole('button', { name: /what would you like to work on today\?/i })).toBeVisible();
  });
});
