import { test, expect } from '@playwright/test';
import {
  dismissSetupModal,
  gotoLanding,
  submitFromLanding,
  ensureActiveSession,
  sendInstruction,
  goHome,
} from './helpers';

test.describe('Return to Home', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('navigate back to home from active chat', async ({ page }) => {
    test.setTimeout(90_000);

    await gotoLanding(page);
    await submitFromLanding(page, 'return home test');
    await ensureActiveSession(page);

    // send a message
    await sendInstruction(page, 'Say hello');
    await expect(page.getByText('Say hello', { exact: true }).first()).toBeVisible();

    // click home button to navigate back to landing page
    await goHome(page);

    // validate landing page is visible
    await expect(page.getByRole('heading', { name: /hey /i })).toBeVisible();
    expect(page.url()).toMatch(/\/dock\/home/);

    // validate landing page input is ready
    await expect(page.getByRole('textbox', { name: 'What would you like to work on?' })).toBeVisible();
  });
});
