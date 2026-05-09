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

    // Step 2: snapshot the tab count so we can find the newly-added tab by
    //         index (preserving stability against pre-existing Claude tabs).
    const initialCount = await page.locator('[data-testid^="tab-shell-"]').count();
    await addTerminalTab(page);
    await expect(page.locator('[data-testid^="tab-shell-"]')).toHaveCount(initialCount + 1);

    // Step 3: find the new terminal tab by matching "Tab N" text, then pin
    //         it by its stable data-testid so follow-up selectors survive the
    //         span → input swap during rename.
    const initialNewTab = page
      .locator('[data-testid^="tab-shell-"]')
      .filter({ has: page.locator('span', { hasText: /^Tab \d+$/ }) })
      .last();
    await expect(initialNewTab).toContainText(/Tab \d+/);
    const newTabTestId = (await initialNewTab.getAttribute('data-testid'))!;
    const newTab = page.locator(`[data-testid="${newTabTestId}"]`);

    // Step 4: double-click the tab NAME span — the one carrying the
    //         onDoubleClick handler (class "text-sm font-medium").
    await newTab.locator('span.text-sm.font-medium').dblclick();

    // Step 5: validate the rename input appears
    const renameInput = newTab.locator('input[type="text"]');
    await expect(renameInput).toBeVisible({ timeout: 5_000 });
    await expect(renameInput).toBeFocused();
    await expect(async () => {
      const selection = await renameInput.evaluate((input: HTMLInputElement) => ({
        start: input.selectionStart,
        end: input.selectionEnd,
        length: input.value.length,
      }));
      expect(selection.start).toBe(0);
      expect(selection.end).toBe(selection.length);
    }).toPass({ timeout: 2_000 });

    // Step 6: type new name; the selected tab text should be replaced.
    await renameInput.type('My Custom Shell');
    await renameInput.press('Enter');

    // Step 7: validate the tab now shows the new name
    await page.waitForTimeout(500);
    await expect(newTab).toContainText('My Custom Shell');
  });
});
