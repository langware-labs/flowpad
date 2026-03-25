import { test, expect } from '@playwright/test';
import {
  dismissSetupModal,
  gotoLanding,
  submitFromLanding,
  ensureActiveSession,
  sendInstruction,
  waitForDone,
} from './helpers';

test.describe('Chat Input Controls', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
    await gotoLanding(page);
    await submitFromLanding(page, 'input controls test');
    await ensureActiveSession(page);
  });

  test('send message via Enter key', async ({ page }) => {
    test.setTimeout(60_000);

    await sendInstruction(page, 'Sent with Enter');

    await expect(page.getByText('Sent with Enter')).toBeVisible();
    const assistantBlocks = page.locator('text=◂ ASSISTANT');
    await expect(assistantBlocks.first()).toBeVisible();
  });

  test('empty submit is blocked', async ({ page }) => {
    const input = page.getByPlaceholder('instruction...');

    // ensure input is empty
    await expect(input).toHaveValue('');

    // press Enter on empty input
    await input.press('Enter');

    // wait a moment - no message should be sent
    await page.waitForTimeout(1_000);

    // status should still be DONE (from the initial beforeEach message)
    await expect(page.getByText('DONE', { exact: true })).toBeVisible();

    // no additional USER message block should appear (only the one from beforeEach)
    const userMarkers = page.locator('text=▸ USER');
    await expect(userMarkers).toHaveCount(1);
  });

  test('stop button visible during execution', async ({ page }) => {
    test.setTimeout(60_000);

    const input = page.getByPlaceholder('instruction...');
    await input.fill('Count from 1 to 100 slowly');
    await input.press('Enter');

    // The stop button should appear while running
    const stopButton = page.locator('button[title="Stop execution"]');
    await expect(stopButton).toBeVisible({ timeout: 5_000 });
    await expect(stopButton).toContainText('stop');

    // Wait for completion
    await waitForDone(page);
  });
});
