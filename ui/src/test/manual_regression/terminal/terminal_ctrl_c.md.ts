import { test } from '@playwright/test';
import { dismissSetupModal, gotoShell, sendCommand, waitForOutput } from './helpers';

test.describe('Terminal Ctrl+C', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('Ctrl+C interrupts a running command', async ({ page }) => {
    test.setTimeout(90_000);

    // Step 1: navigate to shell
    await gotoShell(page);
    await page.waitForTimeout(2_000);

    // Step 2: start a long-running command
    await sendCommand(page, 'sleep 30');

    // Step 3: wait a moment for the command to start
    await page.waitForTimeout(1_000);

    // Step 4: press Ctrl+C to interrupt
    const terminalPanel = page.locator('[data-testid="terminal-panel"][data-active="true"]');
    await terminalPanel.click();
    await page.keyboard.press('Control+c');

    // Step 5: wait for terminal to be ready for new input
    await page.waitForTimeout(1_000);

    // Step 6: verify terminal is responsive by running a new command
    await sendCommand(page, 'echo after interrupt');
    await waitForOutput(page, 'after interrupt');
  });
});
