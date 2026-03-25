import { test, expect } from '@playwright/test';
import { dismissSetupModal, gotoLanding, submitFromLanding, ensureActiveSession, sendInstruction } from './helpers';

test.describe('Chat Refresh Persistence', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('session persists after page refresh', async ({ page }) => {
    test.setTimeout(90_000);

    await gotoLanding(page);
    await submitFromLanding(page, 'refresh test');
    await ensureActiveSession(page);

    // send a message and validate it appears
    await sendInstruction(page, 'Say hello');
    await expect(page.getByText('Say hello')).toBeVisible();

    // refresh the page
    await page.reload();

    // After refresh, session tab and instruction input should persist
    const instructionInput = page.getByPlaceholder('instruction...');
    await instructionInput.waitFor({ state: 'visible', timeout: 15_000 });

    // validate the session tab still exists
    await expect(page.getByText('Session 1')).toBeVisible();
  });
});
