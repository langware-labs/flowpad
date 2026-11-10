import { test, expect } from '@playwright/test';
import { dismissSetupModal, gotoShell, sendCommand, waitForOutput, goHome, gotoShellView } from './helpers';

test.describe('Terminal Persistence on Tab Switch', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('terminal state persists when switching views', async ({ page }) => {
    test.setTimeout(60_000);

    // Step 1: navigate to shell — creates a fresh session at /dock/shell/shell-<uuid>
    await gotoShell(page);

    // Capture the session ID from the URL; tab data-testid is `tab-<sessionId>`
    const shellUrl = page.url();
    const sessionId = shellUrl.split('/dock/shell/').pop() || '';

    // Step 2: run a command and verify output
    await sendCommand(page, 'echo persistence test');
    await waitForOutput(page, 'persistence test');

    // Step 3: navigate to Home via sidebar Home button (client-side React Router nav).
    // This preserves React state (xterm.js PTY sessions stay alive in memory).
    await goHome(page);
    await expect(page.locator('h1, h2, h3').filter({ hasText: /hey /i }).first()).toBeVisible();

    // Step 4: navigate back to Shell via sidebar Shell button (client-side nav)
    // The Shell button calls navigation.openTab(ViewType.SHELL) → React Router navigate
    await gotoShellView(page);

    // Step 5: click the specific session tab by its exact data-testid (`tab-<sessionId>`)
    // This is robust against accumulated sessions from prior test runs.
    const sessionTab = page.locator(`[data-testid="tab-${sessionId}"]`);
    if (await sessionTab.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await sessionTab.click();
      await page.waitForTimeout(1_000);
    }

    // Wait for the correct terminal to be active and rendered
    await page.locator('[data-testid="terminal-panel"][data-active="true"] .xterm-rows')
      .first()
      .waitFor({ state: 'attached', timeout: 10_000 });

    // Step 6: wait for xterm.js to re-render and verify output persisted
    await page.waitForTimeout(2_000);
    await waitForOutput(page, 'persistence test');
  });
});
