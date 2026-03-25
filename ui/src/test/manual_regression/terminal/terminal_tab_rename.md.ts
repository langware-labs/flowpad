import { test, expect } from '@playwright/test';
import { dismissSetupModal, gotoShell, addTerminalTab } from './helpers';

test.describe('Terminal Tab Rename', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('double-click to rename a terminal tab', async ({ page }) => {
    test.setTimeout(90_000);

    // Step 1: navigate to shell
    await gotoShell(page);
    await page.waitForTimeout(1_000);

    // Step 2: add a new terminal tab
    await addTerminalTab(page);

    // Step 3: find the new custom tab (last tab in the list)
    const tabs = page.locator('[data-testid^="tab-"]');
    const newTab = tabs.last();
    await expect(newTab).toContainText(/Terminal/);

    // Step 4: double-click the tab name to start editing
    const tabNameSpan = newTab.locator('span').first();
    await tabNameSpan.dblclick();

    // Step 5: validate the rename input appears
    const renameInput = newTab.locator('input[type="text"]');
    await expect(renameInput).toBeVisible({ timeout: 5_000 });

    // Step 6: clear and type new name
    await renameInput.fill('My Custom Shell');
    await renameInput.press('Enter');

    // Step 7: validate the tab now shows the new name
    await page.waitForTimeout(500);
    await expect(newTab).toContainText('My Custom Shell');
  });
});
