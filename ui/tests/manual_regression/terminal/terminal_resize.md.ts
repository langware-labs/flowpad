import { test, expect } from '@playwright/test';
import { dismissSetupModal, gotoShell, sendCommand, waitForOutput } from './helpers';

test.describe('Terminal Resize', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('terminal resizes when browser window resizes', async ({ page }) => {
    test.setTimeout(60_000);

    // Step 1: navigate to shell
    await gotoShell(page);
    await page.waitForTimeout(2_000);

    // Step 2: run a command to verify terminal works
    await sendCommand(page, 'echo resize test');
    await waitForOutput(page, 'resize test');

    // Step 3: get initial viewport size
    const initialSize = page.viewportSize();
    expect(initialSize).not.toBeNull();

    // Step 4: resize to smaller window
    await page.setViewportSize({ width: 800, height: 400 });
    await page.waitForTimeout(1_000);

    // Step 5: validate terminal is still visible
    const terminalPanels = page.locator('[data-testid="terminal-panels"]');
    await expect(terminalPanels).toBeVisible();

    // Step 6: validate terminal is still functional after resize
    await sendCommand(page, 'echo after small resize');
    await waitForOutput(page, 'after small resize');

    // Step 7: resize back to original (or larger) size
    await page.setViewportSize({
      width: initialSize?.width || 1280,
      height: initialSize?.height || 720,
    });
    await page.waitForTimeout(1_000);

    // Step 8: validate terminal still works after resize back
    await sendCommand(page, 'echo after large resize');
    await waitForOutput(page, 'after large resize');
  });
});
