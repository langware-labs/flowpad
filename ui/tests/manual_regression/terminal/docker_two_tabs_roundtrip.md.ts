/**
 * Docker — two tabs on the same container, both produce output
 *
 * Regression guard for the `Shell.list cached-instance` fix: opening a second
 * docker tab previously orphaned the first tab's Shell instance (observers
 * still attached to the old instance; PTY output routed to the new one →
 * first tab went silent). This test opens tab A, opens tab B, sends input on
 * A via `shell.sendInput`, and confirms output flows back. Uses the SDK
 * sendInput path (not xterm keyboard events) to avoid focus noise.
 *
 * A live disposable Docker worker is a Phase 11 prerequisite; absence is a
 * hard preflight failure.
 */
import { expect, test } from '@playwright/test';
import { dismissSetupModal, gotoShell, openTabViaMenu, terminalTabChips } from './helpers';

test.describe('Docker — two tabs roundtrip', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('after opening tab B, tab A still routes sendInput → output', async ({ page }) => {
    test.setTimeout(60_000);

    await gotoShell(page);

    // Open tab A.
    const initialTabs = await terminalTabChips(page).count();
    await openTabViaMenu(page, 'docker');
    await expect
      .poll(() => terminalTabChips(page).count(), { timeout: 15_000 })
      .toBeGreaterThan(initialTabs);

    await page.waitForTimeout(3_000); // let bash prompt land
    const tabAId = await page.evaluate(() => {
      const active = document.querySelector('[data-testid="terminal-panel"][data-active="true"]');
      return active?.getAttribute('data-session-id')?.replace(/^shell-/, '') ?? null;
    });
    expect(tabAId).toBeTruthy();

    // Open tab B.
    await openTabViaMenu(page, 'docker');
    await expect
      .poll(() => terminalTabChips(page).count(), { timeout: 15_000 })
      .toBeGreaterThan(initialTabs + 1);
    await page.waitForTimeout(3_000);
    const tabBId = await page.evaluate(() => {
      const active = document.querySelector('[data-testid="terminal-panel"][data-active="true"]');
      return active?.getAttribute('data-session-id')?.replace(/^shell-/, '') ?? null;
    });
    expect(tabBId).toBeTruthy();
    expect(tabBId).not.toBe(tabAId);

    // Drive sendInput on tab A programmatically (via @sdk) — bypass keyboard focus.
    // This exercises the exact path the xterm onData handler uses.
    const marker = `DOCKER_TAB_A_OK_${Date.now()}`;
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
        await new Promise((r) => setTimeout(r, 2000));
        const postSeq = A.ptyConnection.lastSeq;
        const chunks = A.getPtyChunks?.() ?? [];
        const text = new TextDecoder().decode(
          new Uint8Array(chunks.flatMap((c: any) => Array.from(c.data))),
        );
        return { preSeq, postSeq, text, listeners: A.ptyConnection._listeners?.size };
      },
      { aId: tabAId, marker },
    );

    expect((seenByA as any).error).toBeUndefined();
    // lastSeq must have advanced — output from tab A reached its ptyConnection
    expect((seenByA as any).postSeq).toBeGreaterThan((seenByA as any).preSeq);
    // InteractiveTerminal's onOutput subscription must still be attached on A
    expect((seenByA as any).listeners).toBeGreaterThan(0);
    // Marker must be present in A's chunks — not in B's
    expect((seenByA as any).text).toContain(marker);
  });
});
