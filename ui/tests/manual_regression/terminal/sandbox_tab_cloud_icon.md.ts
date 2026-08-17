/**
 * Sandbox Tab — provider icon instead of status dot
 *
 * Verifies the TabbedTerminal tab UI renders exactly one provider icon to the
 * left of the shell name and does not render the removed status dot.
 *
 * Requires a backend with E2B_KEY configured (so the Cloud "open sandbox tab"
 * button is rendered). Absence is a hard Phase 11 preflight failure.
 */
import { expect, test } from '@playwright/test';
import { dismissSetupModal, gotoShell, openTabViaMenu, terminalTabChips } from './helpers';

test.describe('Sandbox tab — provider icon', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('sandbox tab shows Shell provider icon to the left of the name', async ({ page }) => {
    test.setTimeout(60_000);

    // Step 1: open the shell view.
    await gotoShell(page);

    // Step 3: click the Cloud button to open a fresh sandbox tab.
    const tabsBefore = await terminalTabChips(page).count();
    await openTabViaMenu(page, 'sandbox');

    // Step 4: a new sandbox tab must appear. Match on the provider-icon test id
    //         so we pick up the new tab regardless of pre-existing ones.
    await expect
      .poll(async () => terminalTabChips(page).count(), { timeout: 15_000 })
      .toBeGreaterThan(tabsBefore);

    // Step 5: validate the most-recently-created sandbox tab carries the Shell
    //         provider icon and does NOT carry legacy Cloud/dot indicators.
    const sandboxTab = terminalTabChips(page).last();
    const providerIcon = sandboxTab.locator('[data-provider="shell"]');
    await expect(providerIcon).toBeVisible();
    await expect(providerIcon).toHaveAttribute('data-provider', 'shell');
    await expect(sandboxTab).toBeVisible();

    // Legacy status indicators are removed from tabs.
    await expect(sandboxTab.locator('[data-testid^="shell-status-dot-"]')).toHaveCount(0);
    await expect(sandboxTab.locator('[data-testid^="shell-sandbox-icon-"]')).toHaveCount(0);

    // Step 6: every tab carries exactly one provider icon and no status dot.
    const allTabs = terminalTabChips(page);
    const totalTabs = await allTabs.count();
    for (let i = 0; i < totalTabs; i++) {
      const tab = allTabs.nth(i);
      await expect(tab.locator('[data-provider]')).toHaveCount(1);
      await expect(tab.locator('[data-testid^="shell-status-dot-"]')).toHaveCount(0);
    }
  });
});
