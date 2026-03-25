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
    const initialTabCount = await page.locator('[data-testid^="tab-"]').count();
    expect(initialTabCount).toBeGreaterThan(0);

    // Step 3: add a new terminal tab
    await addTerminalTab(page);

    // Step 4: validate new tab appeared
    const tabsAfterFirst = page.locator('[data-testid^="tab-"]');
    await expect(tabsAfterFirst).toHaveCount(initialTabCount + 1);

    // Step 5: validate the new tab has "Terminal" in its name
    const newTab = tabsAfterFirst.last();
    await expect(newTab).toContainText(/Terminal/);

    // Step 6: add another tab
    await addTerminalTab(page);
    const tabsAfterSecond = page.locator('[data-testid^="tab-"]');
    await expect(tabsAfterSecond).toHaveCount(initialTabCount + 2);

    // Step 7: click the first custom tab to switch back
    const firstCustomTab = tabsAfterSecond.nth(initialTabCount);
    await firstCustomTab.click();
    await page.waitForTimeout(500);

    // Validate the active panel changed (session ID matches the clicked tab)
    const clickedTabTestId = await firstCustomTab.getAttribute('data-testid');
    const clickedSessionId = clickedTabTestId?.replace('tab-', '');
    const activePanel = page.locator(`[data-testid="terminal-panel"][data-session-id="${clickedSessionId}"]`);
    await expect(activePanel).toBeVisible();

    // Step 8: close a custom tab via X button
    const lastCustomTab = tabsAfterSecond.last();
    const closeButton = lastCustomTab.locator('button[aria-label="Close tab"]');
    await lastCustomTab.hover(); // X button appears on hover
    await closeButton.click();

    // Validate tab count decreased
    await expect(page.locator('[data-testid^="tab-"]')).toHaveCount(initialTabCount + 1);
  });
});
