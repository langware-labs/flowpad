import { test } from '@playwright/test';
import { dismissSetupModal, gotoShell, sendCommand, waitForOutput } from './helpers';

test.describe('Run Basic Command', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('type a command and validate output', async ({ page }) => {
    test.setTimeout(60_000);

    // Step 1: navigate to shell
    await gotoShell(page);

    // Wait for terminal to initialize and PTY to be ready
    await page.waitForTimeout(2_000);

    // Step 2: run echo command
    await sendCommand(page, 'echo hello world');

    // Step 3: validate "hello world" appears in output
    await waitForOutput(page, 'hello world');

    // Step 4: run pwd command
    await sendCommand(page, 'pwd');

    // Step 5: validate a path appears (starts with /)
    await waitForOutput(page, '/');
  });
});
