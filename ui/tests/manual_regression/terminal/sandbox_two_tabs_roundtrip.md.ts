/**
 * E2B sandbox — two tabs, both produce output
 *
 * Parallel guard for the `Shell.list cached-instance` fix: same bug class as
 * docker_two_tabs_roundtrip but on the @sandbox compute node. Not a known
 * failure today but the TS-side code path is shared with docker, so a
 * regression would hit both.
 */
import { expect, test } from '@playwright/test';
import { dismissSetupModal, gotoShell } from './helpers';

test.describe('Sandbox — two tabs roundtrip', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('after opening a second sandbox tab, the first still routes output', async ({ page }) => {
    test.setTimeout(90_000);

    await gotoShell(page);

    const sandboxButton = page.locator('[data-testid="open-sandbox-tab-button"]').first();
    if (!(await sandboxButton.isVisible({ timeout: 2_000 }).catch(() => false))) {
      test.skip(true, 'No @sandbox compute node — E2B_KEY not set');
    }

    const initialTabs = await page.locator('[data-testid^="tab-shell-"]').count();
    await sandboxButton.click();
    await expect
      .poll(() => page.locator('[data-testid^="tab-shell-"]').count(), { timeout: 15_000 })
      .toBeGreaterThan(initialTabs);
    await page.waitForTimeout(5_000); // e2b cold-boot

    const tabAId = await page.evaluate(() => {
      const active = document.querySelector('[data-testid="terminal-panel"][data-active="true"]');
      return active?.getAttribute('data-session-id')?.replace(/^shell-/, '') ?? null;
    });
    expect(tabAId).toBeTruthy();

    await sandboxButton.click();
    await expect
      .poll(() => page.locator('[data-testid^="tab-shell-"]').count(), { timeout: 15_000 })
      .toBeGreaterThan(initialTabs + 1);
    await page.waitForTimeout(5_000);

    const marker = `SANDBOX_TAB_A_OK_${Date.now()}`;
    const seenByA = await page.evaluate(
      async ({ aId, marker }) => {
        const dm = (window as any).dataManager;
        let A: any = null;
        dm.entities.forEach((ref: any) => {
          if (ref?.entity?.id === aId) A = ref.entity;
        });
        if (!A) return { error: 'shell A not in cache' };
        const preSeq = A.ptyConnection.lastSeq;
        await A.sendInput(`echo ${marker}\n`);
        await new Promise((r) => setTimeout(r, 3000));
        return {
          preSeq,
          postSeq: A.ptyConnection.lastSeq,
          listeners: A.ptyConnection._listeners?.size,
        };
      },
      { aId: tabAId, marker },
    );

    expect((seenByA as any).error).toBeUndefined();
    expect((seenByA as any).postSeq).toBeGreaterThan((seenByA as any).preSeq);
    expect((seenByA as any).listeners).toBeGreaterThan(0);
  });
});
