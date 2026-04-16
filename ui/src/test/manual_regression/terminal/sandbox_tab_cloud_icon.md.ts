/**
 * Sandbox Tab — Cloud icon instead of green dot
 *
 * Verifies the TabbedTerminal tab UI distinguishes @sandbox shells from local
 * ones by replacing the usual green status dot with a Cloud icon (to the left
 * of the shell name).
 *
 * Requires a backend with E2B_KEY configured (so the Cloud "open sandbox tab"
 * button is rendered). Auto-skips otherwise.
 */
import { expect, test } from '@playwright/test';
import { dismissSetupModal, gotoShell } from './helpers';

test.describe('Sandbox tab — Cloud icon', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('sandbox tab shows Cloud icon (not green dot) to the left of the name', async ({ page }) => {
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
    const sandboxIconsBefore = await page.locator('[data-testid^="tab-sandbox-icon-"]').count();
    await sandboxButton.click();

    // Step 4: a new sandbox tab must appear. Match on the sandbox-icon test id
    //         so we pick up the new tab regardless of pre-existing ones.
    await expect
      .poll(async () => page.locator('[data-testid^="tab-sandbox-icon-"]').count(), { timeout: 15_000 })
      .toBeGreaterThan(sandboxIconsBefore);

    // Step 5: validate the most-recently-created sandbox tab carries the Cloud
    //         icon and does NOT carry the green status dot.
    const sandboxIcon = page.locator('[data-testid^="tab-sandbox-icon-"]').last();
    await expect(sandboxIcon).toBeVisible();
    const sandboxShellId = (await sandboxIcon.getAttribute('data-testid'))!.replace('tab-sandbox-icon-', '');

    // The Cloud icon is a child of the tab container.
    const sandboxTab = page.locator(`[data-testid="tab-shell-${sandboxShellId}"]`);
    await expect(sandboxTab).toBeVisible();
    await expect(sandboxTab.locator(`[data-testid="tab-sandbox-icon-${sandboxShellId}"]`)).toBeVisible();

    // Exactly one status indicator per tab — sandbox tabs carry the Cloud, not
    // the status dot.
    await expect(sandboxTab.locator(`[data-testid="tab-status-dot-${sandboxShellId}"]`)).toHaveCount(0);

    // Step 6: if any local (non-sandbox) tab is present, it MUST carry the
    //         green status dot and MUST NOT carry a Cloud icon.
    const allTabs = page.locator('[data-testid^="tab-shell-"]');
    const totalTabs = await allTabs.count();
    for (let i = 0; i < totalTabs; i++) {
      const tab = allTabs.nth(i);
      const testId = (await tab.getAttribute('data-testid'))!;
      const shellId = testId.replace('tab-shell-', '');
      const hasCloud = (await tab.locator(`[data-testid="tab-sandbox-icon-${shellId}"]`).count()) > 0;
      const hasDot = (await tab.locator(`[data-testid="tab-status-dot-${shellId}"]`).count()) > 0;
      expect(
        hasCloud !== hasDot,
        `tab ${shellId} must carry exactly one indicator (cloud XOR dot); hasCloud=${hasCloud} hasDot=${hasDot}`,
      ).toBe(true);
    }
  });
});
