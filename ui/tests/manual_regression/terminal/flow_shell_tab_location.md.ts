/**
 * Flow Shell tab location (FLOWPAD-1609).
 * Source: flow_shell_tab_location.md
 *
 * The default ("Flow") shell tab must remain the FIRST tab in the strip after
 * opening additional terminals and reloading the page. Tab order is driven by
 * server tab_order on first fetch; the default shell has the lowest order and
 * must not be displaced by newly-opened terminals (which append at the end).
 */
import { test, expect } from '@playwright/test';
import { dismissSetupModal, gotoShell, addTerminalTab } from './helpers';

test.describe('Flow Shell tab location', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('test 1: Flow shell remains the first tab after opening terminals and refresh', async ({ page }) => {
    test.setTimeout(60_000);

    // Step 1: navigate to shell (creates the default Flow shell tab).
    await gotoShell(page);

    // Record the first tab's testid — this is the Flow shell tab.
    const tabSelector = '[data-testid^="tab-shell|"]';
    await expect(page.locator(tabSelector).first()).toBeVisible({ timeout: 15_000 });
    const flowTabId = await page.locator(tabSelector).first().getAttribute('data-testid');
    expect(flowTabId, 'first (Flow) tab testid').toBeTruthy();
    const initialCount = await page.locator(tabSelector).count();

    // Step 2: open several new terminals (they append at the end of the strip).
    await addTerminalTab(page);
    await addTerminalTab(page);
    await addTerminalTab(page);
    await expect
      .poll(async () => page.locator(tabSelector).count(), { timeout: 15_000 })
      .toBe(initialCount + 3);

    // The Flow shell must still be the first tab before refresh.
    expect(await page.locator(tabSelector).first().getAttribute('data-testid')).toBe(flowTabId);

    // Step 3: refresh the page.
    await page.reload();

    // Re-dismiss any modal after reload.
    const skipForNow = page.getByRole('button', { name: 'Skip for now' });
    if (await skipForNow.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await skipForNow.click();
    }

    // Step 4: Flow shell should remain the first tab.
    await expect(page.locator(tabSelector).first()).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(async () => page.locator(tabSelector).first().getAttribute('data-testid'), { timeout: 15_000 })
      .toBe(flowTabId);
  });
});
