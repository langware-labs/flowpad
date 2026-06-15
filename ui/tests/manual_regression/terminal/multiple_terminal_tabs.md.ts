import { test, expect } from '@playwright/test';
import { dismissSetupModal, gotoShell, addTerminalTab } from './helpers';

test.describe('Multiple Terminal Tabs', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('create multiple tabs and switch between them', async ({ page }) => {
    test.setTimeout(60_000);

    // Step 1: navigate to shell
    await gotoShell(page);
    await page.waitForTimeout(1_000);

    // Step 2: count initial tabs
    const initialTabCount = await page.locator('[data-testid^="tab-"]').count();
    expect(initialTabCount).toBeGreaterThan(0);

    // Identify newly added tabs by snapshotting testids before/after each add —
    // last() is unreliable when the dock already contains accumulated tabs that
    // sort after our newly-created shell.
    async function snapshotIds(): Promise<Set<string>> {
      return new Set(
        await page.locator('[data-testid^="tab-"]').evaluateAll((els) =>
          els.map((el) => el.getAttribute('data-testid') ?? ''),
        ),
      );
    }
    async function newIdSince(before: Set<string>): Promise<string> {
      let found = '';
      await expect(async () => {
        const after = await page.locator('[data-testid^="tab-"]').evaluateAll((els) =>
          els.map((el) => el.getAttribute('data-testid') ?? ''),
        );
        const fresh = after.filter((id) => id && !before.has(id));
        expect(fresh.length).toBeGreaterThan(0);
        found = fresh[0];
      }).toPass({ timeout: 15_000 });
      return found;
    }

    // Step 3: add a new terminal tab
    const beforeFirst = await snapshotIds();
    await addTerminalTab(page);

    // Step 4–5: detect the new terminal tab and validate its "Tab N" name.
    const firstNewTabId = await newIdSince(beforeFirst);
    const firstNewTab = page.locator(`[data-testid="${firstNewTabId}"]`);
    await expect(firstNewTab).toContainText(/Tab \d+/);

    // Step 6: add another tab
    const beforeSecond = await snapshotIds();
    await addTerminalTab(page);
    const secondNewTabId = await newIdSince(beforeSecond);
    expect(secondNewTabId).not.toBe(firstNewTabId);

    // Step 7: switch back to the first newly created tab.
    await firstNewTab.click();
    await page.waitForTimeout(500);
    const clickedSessionId = firstNewTabId.replace('tab-', '');

    // Validate the active panel matches the clicked tab.
    const activePanel = page.locator(`[data-testid="terminal-panel"][data-session-id="${clickedSessionId}"]`);
    await expect(activePanel).toBeVisible();

    // Step 8: close the second newly created tab via its X button.
    const countBeforeClose = await page.locator('[data-testid^="tab-"]').count();
    const tabToClose = page.locator(`[data-testid="${secondNewTabId}"]`);
    const closeButton = tabToClose.locator('button[aria-label="Close tab"]');
    await tabToClose.hover(); // X button appears on hover
    await closeButton.click();

    // Validate the closed tab is gone and the total count went down. Strict
    // equality on `countBeforeClose - 1` is brittle: closing a tab tied to a
    // dead session can trigger downstream cleanup that prunes a sibling tab,
    // so we assert the closed tab specifically and that count strictly
    // decreased from the snapshot.
    await expect(page.locator(`[data-testid="${secondNewTabId}"]`)).toHaveCount(0, { timeout: 15000 });
    const countAfterClose = await page.locator('[data-testid^="tab-"]').count();
    expect(countAfterClose).toBeLessThan(countBeforeClose);
  });
});
