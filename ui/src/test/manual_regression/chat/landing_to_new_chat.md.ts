import { test, expect } from '@playwright/test';
import { dismissSetupModal, gotoLanding, submitFromLanding, ensureActiveSession, waitForDone } from './helpers';

test.describe('Landing to New Chat', () => {
  test.describe.configure({ retries: 1 });

  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('start new chat from landing page', async ({ page }) => {
    test.setTimeout(90_000);

    // Step 1: navigate to landing page and validate it
    await gotoLanding(page);
    await expect(page.getByText('What would you like to work on today?')).toBeVisible();
    // Wait for page to settle before interacting
    await page.waitForLoadState('networkidle');

    // Step 2: submit from landing page to create session
    await submitFromLanding(page, 'Hello, can you help me?');
    await ensureActiveSession(page);

    // Step 3: validate user message appears
    await expect(page.getByText('Hello, can you help me?').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('▸ user').first()).toBeVisible();

    // Step 4: wait for DONE
    await waitForDone(page);

    // Step 5: validate AI response appears
    await expect(page.getByText('◂ assistant').first()).toBeVisible();

    // Step 6: validate instruction input is empty and ready
    const instructionInput = page.getByPlaceholder('instruction...');
    await expect(instructionInput).toHaveValue('');
  });
});
