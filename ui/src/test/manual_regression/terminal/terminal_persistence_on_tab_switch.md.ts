import { test, expect } from '@playwright/test';
import { dismissSetupModal, gotoShell, sendCommand, waitForOutput, goHome } from './helpers';

test.describe('Terminal Persistence on Tab Switch', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('terminal state persists when switching views', async ({ page }) => {
    test.setTimeout(90_000);

    // Step 1: navigate to shell
    await gotoShell(page);

    // Step 2: run a command
    await sendCommand(page, 'echo persistence test');
    await waitForOutput(page, 'persistence test');

    // Capture the current shell URL so we can navigate back to it
    const shellUrl = page.url();

    // Step 3: navigate to Home
    await goHome(page);
    await expect(page.getByRole('heading', { name: /hey /i })).toBeVisible();

    // Step 4: navigate back to the same Shell session
    await page.goto(shellUrl);
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 10_000 });
    await page
      .locator('[data-testid="terminal-panel"][data-active="true"] .xterm-rows')
      .first()
      .waitFor({ state: 'attached', timeout: 10_000 });

    // Step 5: wait for terminal to re-render and check output persistence
    await page.waitForTimeout(2_000);
    await waitForOutput(page, 'persistence test');
  });
});
