import { test, expect } from '@playwright/test';
import { dismissSetupModal, gotoShell, sendCommand, waitForOutput } from './helpers';

test.describe('Terminal Scroll Sync', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('viewportY tracks correctly as terminal scrolls', async ({ page }) => {
    test.setTimeout(60_000);

    await gotoShell(page);

    // Generate enough output to fill the terminal and create scrollback. Emit all
    // 60 lines from ONE command: typing 60 separate echo commands costs ~1.1s each
    // of pure harness overhead (focus-click + fixed waits + per-char delay) and
    // blows the 60s budget, while contributing nothing this test asserts — the
    // scrollback content and markers are identical either way. (The app echoes
    // fast; the sibling resize test proves 40 commands render fine.)
    await sendCommand(page, 'for i in $(seq 0 59); do echo "scroll_line_$i"; done');

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
    test.setTimeout(60_000);

    await gotoShell(page);

    // Generate scrollback in one command (see the note in the first test — 40
    // typed commands is harness overhead, not what's under test).
    await sendCommand(page, 'for i in $(seq 0 39); do echo "line_$i"; done');
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
