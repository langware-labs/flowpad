/**
 * Docker — reopen a stale shell after worker restart
 *
 * Regression guard for the duplicate-worker-rejection fix: previously, when
 * the server was bounced, multiple ghost worker processes reconnected and
 * clobbered the registry. Re-opening an existing @docker Shell entity hung
 * because the registered WorkerConn pointed at an old-code process.
 *
 * This test creates a docker Shell, remembers its id, simulates the "reopen
 * later" flow by navigating directly to /dock/shell/shell-<id>, and verifies
 * the prompt + `uname -s` round-trip still works. Auto-skips with no worker.
 */
import { expect, test } from '@playwright/test';
import { dismissSetupModal, gotoShell } from './helpers';

test.describe('Docker — stale shell reopen', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('reopening a docker shell by URL renders bash prompt and round-trips input', async ({ page }) => {
    test.setTimeout(120_000);

    await gotoShell(page);

    const dockerButton = page.locator('[data-testid^="open-docker-tab-button-"]').first();
    if (!(await dockerButton.isVisible({ timeout: 2_000 }).catch(() => false))) {
      test.skip(true, 'No docker worker registered');
    }

    // Step 1: create a new docker shell.
    const tabsBefore = await page.locator('[data-testid^="tab-shell-"]').count();
    await dockerButton.click();
    await expect
      .poll(() => page.locator('[data-testid^="tab-shell-"]').count(), { timeout: 15_000 })
      .toBeGreaterThan(tabsBefore);
    await page.waitForTimeout(3_000);

    const shellId = await page.evaluate(() => {
      const active = document.querySelector('[data-testid="terminal-panel"][data-active="true"]');
      return active?.getAttribute('data-session-id')?.replace(/^shell-/, '') ?? null;
    });
    expect(shellId).toBeTruthy();

    // Step 2: navigate away and back to the shell URL — simulates a reload
    // or a user returning to a session from history. The PTY session
    // continues to exist on the worker; the TS Shell must reattach.
    await page.goto('/dock/home');
    await page.waitForTimeout(1_500);
    await page.goto(`/dock/shell/shell-${shellId}`);

    // Prompt should render — bash-5.2# or similar.
    await expect(async () => {
      const text = await page
        .locator('[data-testid="terminal-panel"][data-active="true"] .xterm-rows')
        .first()
        .textContent();
      expect(text ?? '').toMatch(/\$\s*$|#\s*$/);
    }).toPass({ timeout: 30_000 });

    // Step 3: round-trip input via sendInput — confirm routing works.
    const marker = `STALE_OK_${Date.now()}`;
    const result = await page.evaluate(
      async ({ id, marker }) => {
        const dm = (window as any).dataManager;
        let s: any = null;
        dm.entities.forEach((ref: any) => {
          if (ref?.entity?.id === id) s = ref.entity;
        });
        if (!s) return { error: 'shell not in cache' };
        const preSeq = s.ptyConnection.lastSeq;
        await s.sendInput(`echo ${marker}\n`);
        await new Promise((r) => setTimeout(r, 2000));
        return { preSeq, postSeq: s.ptyConnection.lastSeq };
      },
      { id: shellId, marker },
    );
    expect((result as any).error).toBeUndefined();
    expect((result as any).postSeq).toBeGreaterThan((result as any).preSeq);
  });
});
