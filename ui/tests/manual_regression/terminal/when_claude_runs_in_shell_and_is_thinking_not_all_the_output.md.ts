import { test, expect } from '@playwright/test';
import { dismissSetupModal, gotoShell, addTerminalTab } from './helpers';

test.describe('Terminal output persists after tab switching', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('Terminal output remains visible after switching tabs while a process runs (FLOWPAD-1617)', async ({ page }) => {
    test.setTimeout(120_000);

    await gotoShell(page);

    // Capture session ID from URL — tab data-testid is `tab-<sessionId>`
    // This is robust against 50+ accumulated sessions from prior test runs.
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
    await page.locator(`[data-testid="tab-${sessionId}"]`).click();
    await page.waitForTimeout(2_000);

    // Terminal should still be visible and active after switching back
    await expect(page.locator('[data-testid="terminal-panels"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="terminal-panel"][data-active="true"] .xterm-rows').first(),
    ).toBeAttached();
  });
});
