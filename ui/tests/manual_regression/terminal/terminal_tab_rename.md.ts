import { test, expect } from '@playwright/test';
import { dismissSetupModal, gotoShell, addTerminalTab } from './helpers';

test.describe('Terminal Tab Rename', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('double-click to rename a terminal tab', async ({ page }) => {
    test.setTimeout(60_000);

    // Step 1: navigate to shell (creates a new shell and navigates to it)
    await gotoShell(page);
    await page.waitForTimeout(1_000);

    // Step 2: capture existing tab testids before adding a new one
    const existingTabIds = new Set(
      await page.locator('[data-testid^="tab-"]').evaluateAll(
        (els) => els.map((el) => el.getAttribute('data-testid') ?? '')
      )
    );

    // Step 3: add a new terminal tab
    await addTerminalTab(page);

    // Step 4: wait for a NEW tab to appear (one whose testid was not in existingTabIds)
    let newTabTestId: string | null = null;
    await expect(async () => {
      const currentIds = await page.locator('[data-testid^="tab-"]').evaluateAll(
        (els) => els.map((el) => el.getAttribute('data-testid') ?? '')
      );
      const newIds = currentIds.filter((id) => id && !existingTabIds.has(id));
      expect(newIds.length).toBeGreaterThan(0);
      newTabTestId = newIds[0]; // pick the first new tab
    }).toPass({ timeout: 10_000 });

    expect(newTabTestId).toBeTruthy();
    const newTab = page.locator(`[data-testid="${newTabTestId}"]`);
    await expect(newTab).toContainText(/Tab \d+/);

    // Step 5: click the tab to make it active, then double-click the name span to start editing.
    // The tab contains two spans: first is the status dot (h-2 w-2), second is the name text.
    // Use dispatchEvent('dblclick') to avoid overflow-scroll interception in a crowded tab strip.
    await newTab.click({ force: true }); // ensure tab is active + scrolled into view
    await page.waitForTimeout(200);
    const tabNameSpan = newTab.locator('span.font-medium');
    await tabNameSpan.dispatchEvent('dblclick');
    // Give React time to process the dblclick and update state (show rename input)
    await page.waitForTimeout(500);

    // Step 6: validate the rename input appears
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

    // Step 7: type new name; the selected tab text should be replaced.
    await renameInput.type('My Custom Shell');
    await page.waitForTimeout(200);
    await renameInput.press('Enter');

    // Step 8: validate the tab now shows the new name.
    // The name update propagates via entity notification — use toPass() to retry.
    await expect(async () => {
      const text = await newTab.locator('span.font-medium').textContent();
      expect(text?.trim()).toBe('My Custom Shell');
    }).toPass({ timeout: 15_000 });
  });
});
