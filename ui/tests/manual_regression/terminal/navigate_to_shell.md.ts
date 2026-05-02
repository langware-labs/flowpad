import { test, expect } from '@playwright/test';
import { dismissSetupModal, gotoShell } from './helpers';

test.describe('Navigate to Shell', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('open the shell view and validate terminal loads', async ({ page }) => {
    test.setTimeout(90_000);

    // Step 1: navigate to shell (creates a new terminal via /dock/shell/new_terminal)
    await gotoShell(page);

    // Step 2: validate URL contains /dock/shell/shell-
    expect(page.url()).toMatch(/\/dock\/shell\/shell-/);

    // Step 3: validate terminal tab bar has at least one tab
    const tabs = page.locator('[data-testid^="tab-"]');
    await expect(tabs.first()).toBeVisible({ timeout: 10_000 });

    // Step 4: validate terminal content area is visible
    const terminalPanels = page.locator('[data-testid="terminal-panels"]');
    await expect(terminalPanels).toBeVisible();

    // Step 5: validate active terminal panel exists
    const activePanel = page.locator('[data-testid="terminal-panel"][data-active="true"]');
    await expect(activePanel).toBeVisible();

    // Step 6: validate xterm.js rendered (has .xterm-rows)
    const xtermRows = page.locator('.xterm-rows').first();
    await expect(xtermRows).toBeAttached();

    // Step 7: validate the tab-opener "+" button is visible.
    // opener-plus-button only renders when the terminal opener is pinned;
    // opener-plus-button is the always-present affordance.
    const addButton = page.locator('[data-testid="opener-plus-button"]');
    await expect(addButton).toBeVisible();
  });
});
