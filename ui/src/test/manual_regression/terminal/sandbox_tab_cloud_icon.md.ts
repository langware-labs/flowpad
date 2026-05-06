/**
 * Sandbox Tab — provider icon instead of status dot
 *
 * Verifies the TabbedTerminal tab UI renders exactly one provider icon to the
 * left of the shell name and does not render the removed status dot.
 *
 * Requires a backend with E2B_KEY configured (so the Cloud "open sandbox tab"
 * button is rendered). Auto-skips otherwise.
 */
import { expect, test } from '@playwright/test';
import { dismissSetupModal, gotoShell } from './helpers';

test.describe('Sandbox tab — provider icon', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('sandbox tab shows Shell provider icon to the left of the name', async ({ page }) => {
    test.setTimeout(60_000);

    // Step 1: open the shell view.
    await gotoShell(page);

    // Step 2: the Cloud (sandbox-tab) button only appears when the backend
    //         reports sandbox_available=true (E2B_KEY configured on backend).
    //         Skip cleanly when the gate is off.
    const sandboxButton = page.locator('[data-testid="open-sandbox-tab-button"]');
    if (!(await sandboxButton.isVisible({ timeout: 2_000 }).catch(() => false))) {
      test.skip(true, 'No @sandbox compute node — backend not configured with E2B_KEY');
    }

    // Step 3: click the Cloud button to open a fresh sandbox tab.
    const providerIconsBefore = await page.locator('[data-testid^="tab-provider-icon-"]').count();
    await sandboxButton.click();

    // Step 4: a new sandbox tab must appear. Match on the provider-icon test id
    //         so we pick up the new tab regardless of pre-existing ones.
    await expect
      .poll(async () => page.locator('[data-testid^="tab-provider-icon-"]').count(), { timeout: 15_000 })
      .toBeGreaterThan(providerIconsBefore);

    // Step 5: validate the most-recently-created sandbox tab carries the Shell
    //         provider icon and does NOT carry legacy Cloud/dot indicators.
    const providerIcon = page.locator('[data-testid^="tab-provider-icon-"]').last();
    await expect(providerIcon).toBeVisible();
    await expect(providerIcon).toHaveAttribute('data-provider', 'shell');
    const sandboxShellId = (await providerIcon.getAttribute('data-testid'))!.replace('tab-provider-icon-', '');

    // The provider icon is a child of the tab container.
    const sandboxTab = page.locator(`[data-testid="tab-shell-${sandboxShellId}"]`);
    await expect(sandboxTab).toBeVisible();
    await expect(sandboxTab.locator(`[data-testid="tab-provider-icon-${sandboxShellId}"]`)).toBeVisible();

    // Legacy status indicators are removed from tabs.
    await expect(sandboxTab.locator(`[data-testid="shell-status-dot-${sandboxShellId}"]`)).toHaveCount(0);
    await expect(sandboxTab.locator(`[data-testid="shell-sandbox-icon-${sandboxShellId}"]`)).toHaveCount(0);

    // Step 6: every tab carries exactly one provider icon and no status dot.
    const allTabs = page.locator('[data-testid^="tab-shell-"]');
    const totalTabs = await allTabs.count();
    for (let i = 0; i < totalTabs; i++) {
      const tab = allTabs.nth(i);
      const testId = (await tab.getAttribute('data-testid'))!;
      const shellId = testId.replace('tab-shell-', '');
      await expect(tab.locator(`[data-testid="tab-provider-icon-${shellId}"]`)).toHaveCount(1);
      await expect(tab.locator(`[data-testid="shell-status-dot-${shellId}"]`)).toHaveCount(0);
    }
  });
});
