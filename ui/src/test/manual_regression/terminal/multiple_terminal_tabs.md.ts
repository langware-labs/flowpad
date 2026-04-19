import { test, expect } from '@playwright/test';
import { dismissSetupModal, gotoShell, addTerminalTab } from './helpers';

test.describe('Multiple Terminal Tabs', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('create multiple tabs and switch between them', async ({ page }) => {
    test.setTimeout(90_000);

    // Step 1: navigate to shell
    await gotoShell(page);
    await page.waitForTimeout(1_000);

    // Step 2: count initial tabs
    const initialTabCount = await page.locator('[data-testid^="tab-shell-"]').count();
    expect(initialTabCount).toBeGreaterThan(0);

    // Step 3: add a new terminal tab
    await addTerminalTab(page);

    // Step 4: validate new tab appeared
    const tabsAfterFirst = page.locator('[data-testid^="tab-shell-"]');
    await expect(tabsAfterFirst).toHaveCount(initialTabCount + 1);

    // Step 5: the newly-added terminal is the one whose span reads "Tab N".
    // Tab order isn't guaranteed vs pre-existing Claude tabs, so locate by text.
    const newTerminalTabs = tabsAfterFirst.filter({ has: page.locator('span', { hasText: /^Tab \d+$/ }) });
    const firstNewTab = newTerminalTabs.first();
    await expect(firstNewTab).toContainText(/Tab \d+/);

    // Step 6: add another tab
    await addTerminalTab(page);
    const tabsAfterSecond = page.locator('[data-testid^="tab-shell-"]');
    await expect(tabsAfterSecond).toHaveCount(initialTabCount + 2);

    // Step 7: click the first "Tab N" custom tab to switch back.
    const customTabs = tabsAfterSecond.filter({ has: page.locator('span', { hasText: /^Tab \d+$/ }) });
    const firstCustomTab = customTabs.first();
    await firstCustomTab.click();
    await page.waitForTimeout(500);

    // Validate the active panel changed (session ID matches the clicked tab)
    const clickedTabTestId = await firstCustomTab.getAttribute('data-testid');
    const clickedSessionId = clickedTabTestId?.replace('tab-', '');
    const activePanel = page.locator(`[data-testid="terminal-panel"][data-session-id="${clickedSessionId}"]`);
    await expect(activePanel).toBeVisible();

    // Step 8: close the last custom Tab N tab via X button.
    const lastCustomTab = customTabs.last();
    const closeButton = lastCustomTab.locator('button[aria-label="Close tab"]');
    await lastCustomTab.hover(); // X button appears on hover
    await closeButton.click();

    // Validate tab count decreased
    await expect(page.locator('[data-testid^="tab-shell-"]')).toHaveCount(initialTabCount + 1);
  });
});
