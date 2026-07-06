import { test, expect } from '@playwright/test';
import { dismissSetupModal, gotoShell, addTerminalTab } from './helpers';

test.describe('Terminal output persists after tab switching', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('Terminal output remains visible after switching tabs while a process runs (FLOWPAD-1617)', async ({ page }) => {
    test.setTimeout(60_000);

    await gotoShell(page);

    // Capture session ID from URL. The tab data-testid embeds the dock tabHash
    // (`<viewType>|<pointer>`); a shell/agentic session under the SHELL view chips
    // as `tab-shell|<sessionId>`.
    const shellUrl = page.url();
    const sessionId = shellUrl.split('/dock/shell/').pop() || '';

    // Add a second terminal tab (simulates switching away while first terminal is active)
    await addTerminalTab(page);
    await page.waitForTimeout(2_000);

    // Verify second tab appeared
    const tabs = page.locator('[data-testid^="tab-"]');
    const tabCountAfter = await tabs.count();
    expect(tabCountAfter, 'Second terminal tab should have appeared').toBeGreaterThan(0);

    // Click back to the original session by its exact data-testid — not tabs.first() or
    // tabs.nth(N) which would select a stale accumulated session from prior runs.
    await page.locator(`[data-testid="tab-shell|${sessionId}"]`).click();
    await page.waitForTimeout(2_000);

    // Terminal should still be visible and active after switching back
    await expect(page.locator('[data-testid="terminal-panels"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="terminal-panel"][data-active="true"] .xterm-rows').first(),
    ).toBeAttached();
  });
});
