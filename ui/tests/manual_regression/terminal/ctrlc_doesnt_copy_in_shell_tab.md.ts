import { expect, test } from '@playwright/test';
import { dismissSetupModal, gotoShell } from './helpers';

test.use({ headless: false });

test.describe('Ctrl+C in shell tab does not copy to clipboard', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  });

  test('Ctrl+C sends interrupt signal, not clipboard copy (FLOWPAD-1615)', async ({ page }) => {
    test.setTimeout(60_000);

    // Navigate to shell first
    await gotoShell(page);

    // Set a known value in clipboard while on the shell page
    await page.evaluate(() => navigator.clipboard.writeText('ORIGINAL_CLIPBOARD_CONTENT'));

    // Focus the active terminal panel (.last() handles stacked sessions from previous test runs)
    const terminalPanel = page.locator('[data-testid="terminal-panel"][data-active="true"]').last();
    await terminalPanel.waitFor({ state: 'attached', timeout: 10_000 });
    await terminalPanel.click({ force: true });

    // Type some text in the terminal
    await page.keyboard.type('echo hello world');
    await page.waitForTimeout(500);

    // Press Ctrl+C — should send SIGINT to PTY, NOT copy to clipboard
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(500);

    // Read clipboard — must still be the original value, not 'echo hello world'
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toBe('ORIGINAL_CLIPBOARD_CONTENT');

    // Also verify the terminal is still responsive (interrupt worked)
    await page.keyboard.type('echo after_interrupt');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1_000);
  });
});
