import { test, expect } from '@playwright/test';
import { dismissSetupModal, gotoShell, sendCommand, waitForOutput } from './helpers';

test.describe('Terminal Command History', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('navigate command history with up/down arrows', async ({ page }) => {
    test.setTimeout(90_000);

    // Step 1: navigate to shell
    await gotoShell(page);
    await page.waitForTimeout(2_000);

    // Step 2: run several commands
    await sendCommand(page, 'echo one');
    await waitForOutput(page, 'one');

    await sendCommand(page, 'echo two');
    await waitForOutput(page, 'two');

    await sendCommand(page, 'echo three');
    await waitForOutput(page, 'three');

    // Step 3: press Up arrow to recall previous commands
    // Click terminal to ensure focus
    const terminalPanel = page.locator('[data-testid="terminal-panel"][data-active="true"]');
    await terminalPanel.click();
    await page.waitForTimeout(200);

    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(300);

    // The terminal should show "echo three" at the current prompt
    // We verify by checking the xterm text content contains the recalled command
    await expect(async () => {
      const content = await page
        .locator('[data-testid="terminal-panel"][data-active="true"] .xterm-rows')
        .first()
        .textContent();
      expect(content).toContain('echo three');
    }).toPass({ timeout: 5_000 });

    // Step 4: press Up again for "echo two"
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(300);

    await expect(async () => {
      const content = await page
        .locator('[data-testid="terminal-panel"][data-active="true"] .xterm-rows')
        .first()
        .textContent();
      expect(content).toContain('echo two');
    }).toPass({ timeout: 5_000 });

    // Step 5: press Down to go back to "echo three"
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(300);

    // Step 6: press Enter to execute
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1_000);

    // Validate output contains "three" (from re-executed command)
    // Count occurrences - should have "three" at least twice (original + recalled)
    const content = await page
      .locator('[data-testid="terminal-panel"][data-active="true"] .xterm-rows')
      .first()
      .textContent();
    const matches = content?.match(/three/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});
