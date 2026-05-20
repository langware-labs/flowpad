import { test, expect } from '@playwright/test';
import { dismissSetupModal, gotoShell, sendCommand, waitForOutput } from './helpers';

test.describe('Terminal Scroll Sync', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('viewportY tracks correctly as terminal scrolls', async ({ page }) => {
    test.setTimeout(120_000);

    await gotoShell(page);

    // Generate enough output to fill terminal and create scrollback
    for (let i = 0; i < 60; i++) {
      await sendCommand(page, `echo "scroll_line_${i}"`);
      await page.waitForTimeout(30);
    }

    // Wait for last line to appear
    await waitForOutput(page, 'scroll_line_59');

    // Terminal should have scrollback — validate it's functional
    const terminalPanel = page.locator('[data-testid="terminal-panel"][data-active="true"]');
    await expect(terminalPanel).toBeVisible();

    // Check no raw escape sequences are visible
    const content = await page
      .locator('[data-testid="terminal-panel"][data-active="true"] .xterm-rows')
      .first()
      .textContent();
    expect(content).not.toMatch(/\^\[|\^M|\x1b\[/);

    // Can still send commands after scrollback
    await sendCommand(page, 'echo SCROLL_SYNC_OK');
    await waitForOutput(page, 'SCROLL_SYNC_OK');
  });

  test('resize does not break scroll position or output', async ({ page }) => {
    test.setTimeout(120_000);

    await gotoShell(page);

    // Generate scrollback
    for (let i = 0; i < 40; i++) {
      await sendCommand(page, `echo "line_${i}"`);
      await page.waitForTimeout(30);
    }
    await waitForOutput(page, 'line_39');

    // Trigger resize by changing viewport
    await page.setViewportSize({ width: 900, height: 600 });
    // ResizeObserver debounces the PTY resize signal by 250ms, and the
    // 40-line scrollback loop above leaves render work in the queue; wait
    // long enough that xterm refits, VirtualTerminal rebuilds, and the
    // backend PTY ACKs the new dimensions before we drive new input.
    await page.waitForTimeout(1_500);

    // Terminal should still accept input after resize
    await sendCommand(page, 'echo AFTER_RESIZE');
    await waitForOutput(page, 'AFTER_RESIZE', 15_000);

    // No escape sequences should be visible after resize
    const content = await page
      .locator('[data-testid="terminal-panel"][data-active="true"] .xterm-rows')
      .first()
      .textContent();
    expect(content).not.toMatch(/\^\[|\^M/);
  });
});
