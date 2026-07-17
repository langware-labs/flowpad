import { test, expect } from '@playwright/test';
import {
  dismissSetupModal,
  gotoLanding,
  submitFromLanding,
  ensureActiveSession,
  sendInstruction,
  waitForDone,
} from './helpers';

test.describe('Chat Streaming', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('validate streaming execution and completion', async ({ page }) => {
    test.setTimeout(60_000);

    await gotoLanding(page);
    await submitFromLanding(page, 'streaming test');
    await ensureActiveSession(page);

    const input = page.getByPlaceholder('instruction...');
    // Ensure initial processing from submitFromLanding is complete
    await waitForDone(page);
    await input.fill('Explain how a computer works');
    await input.press('Enter');

    // validate stop button appears during execution
    const stopButton = page.locator('button[title="Stop execution"]');
    await expect(stopButton).toBeVisible({ timeout: 5_000 });

    // wait for completion
    await waitForDone(page);

    // validate DONE status
    await expect(page.getByText('DONE', { exact: true })).toBeVisible();

    // validate stop button is hidden after completion
    await expect(stopButton).not.toBeVisible();

    // validate assistant response is visible
    await expect(page.locator('text=◂ assistant').first()).toBeVisible();

    // validate input is ready again
    await expect(input).toBeEditable();
  });

  test('multiple streaming responses in sequence', async ({ page }) => {
    test.setTimeout(120_000);

    await gotoLanding(page);
    await submitFromLanding(page, 'sequential streaming');
    await ensureActiveSession(page);

    // first message
    await sendInstruction(page, 'What is 1+1?');
    await expect(page.getByText('What is 1+1?')).toBeVisible();
    await expect(page.locator('text=◂ assistant').first()).toBeVisible();

    // second message
    await sendInstruction(page, 'What is 2+2?');
    await expect(page.getByText('What is 2+2?')).toBeVisible();

    // validate all responses rendered (1 from submitFromLanding + 2 from sendInstruction)
    const assistantBlocks = page.locator('text=◂ assistant');
    await expect(assistantBlocks).toHaveCount(3, { timeout: 10_000 });

    // validate messages are in correct order (1 from submitFromLanding + 2 from sendInstruction)
    const userBlocks = page.locator('text=▸ user');
    await expect(userBlocks).toHaveCount(3, { timeout: 5_000 });
  });
});
