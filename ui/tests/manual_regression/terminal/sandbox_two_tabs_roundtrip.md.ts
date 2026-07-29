/**
 * E2B sandbox — two tabs, both produce output
 *
 * Parallel guard for the `Shell.list cached-instance` fix: same bug class as
 * docker_two_tabs_roundtrip but on the @sandbox compute node. Not a known
 * failure today but the TS-side code path is shared with docker, so a
 * regression would hit both. E2B_KEY is a Phase 11 prerequisite; its absence
 * is a hard preflight failure.
 */
import { expect, test } from '@playwright/test';
import { dismissSetupModal, gotoShell, openTabViaMenu, terminalTabChips } from './helpers';

test.describe('Sandbox — two tabs roundtrip', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('after opening a second sandbox tab, the first still routes output', async ({ page }) => {
    test.setTimeout(60_000);

    await gotoShell(page);

    const initialTabs = await terminalTabChips(page).count();
    await openTabViaMenu(page, 'sandbox');
    await expect
      .poll(() => terminalTabChips(page).count(), { timeout: 15_000 })
      .toBeGreaterThan(initialTabs);
    await page.waitForTimeout(5_000); // e2b cold-boot

    const tabAId = await page.evaluate(() => {
      const active = document.querySelector('[data-testid="terminal-panel"][data-active="true"]');
      return active?.getAttribute('data-session-id')?.replace(/^shell-/, '') ?? null;
    });
    expect(tabAId).toBeTruthy();

    await openTabViaMenu(page, 'sandbox');
    await expect
      .poll(() => terminalTabChips(page).count(), { timeout: 15_000 })
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
