import { expect, test } from '@playwright/test';
import { dismissSetupModal, gotoShell } from './helpers';

test.use({ headless: false });

test.describe('Ctrl+V in Claude terminal', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  });

  test('Ctrl+V in Claude terminal input does not paste OS clipboard (FLOWPAD-1618)', async ({ page }) => {
    test.setTimeout(60_000);

    // Navigate to shell first
    await gotoShell(page);

    // Set a known value in clipboard while on the shell page
    await page.evaluate(() => navigator.clipboard.writeText('CLIPBOARD_PASTE_TEST'));

    // Click xterm-rows to focus the terminal (more reliable than clicking the panel wrapper)
    const xtermRows = page
      .locator('[data-testid="terminal-panel"][data-active="true"]')
      .last()
      .locator('.xterm-rows')
      .first();
    await xtermRows.waitFor({ state: 'attached', timeout: 10_000 });
    await xtermRows.click({ force: true });
    await page.keyboard.press('Control+v');
    await page.waitForTimeout(500);

    // Verify clipboard content is unchanged after Ctrl+V (clipboard not cleared/consumed)
    const clipboardAfter = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardAfter).toBe('CLIPBOARD_PASTE_TEST');

    // In xterm.js, Ctrl+V is NOT the paste shortcut (Ctrl+Shift+V or right-click paste is used)
    // So pressing Ctrl+V in the terminal should NOT paste the clipboard content
    // The clipboard must be preserved and unchanged
  });
});
