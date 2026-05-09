/**
 * Sandbox Terminal — uname -a end-to-end
 *
 * Drives the sandbox terminal the way a user would:
 *   1. Open the Shell view.
 *   2. Click the Cloud button in the terminal toolbar.
 *   3. Wait for the sandbox tab to become active.
 *   4. Type `uname -a` into the xterm.js terminal.
 *   5. Wait for "Linux" to appear in the xterm output.
 *   6. Print the full OS line the terminal rendered back to the test log so a
 *      human can see what the sandbox actually reported.
 *
 * Auto-skips when the backend has no E2B_KEY (no Cloud button rendered).
 */
import { expect, test } from '@playwright/test';
import { dismissSetupModal, gotoShell } from './helpers';

test.describe('Sandbox terminal — uname -a', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('user types `uname -a` in a sandbox tab and sees Linux OS info', async ({ page }) => {
    test.setTimeout(90_000);

    await gotoShell(page);

    // Cloud button is gated on bootstrap.sandbox_available. Skip cleanly when
    // the backend has no E2B_KEY configured.
    const sandboxButton = page.locator('[data-testid="open-sandbox-tab-button"]');
    if (!(await sandboxButton.isVisible({ timeout: 2_000 }).catch(() => false))) {
      test.skip(true, 'No @sandbox compute node — backend not configured with E2B_KEY');
    }

    // Click the Cloud button — this creates a sandbox Shell and navigates to it.
    const providerIconsBefore = await page.locator('[data-testid^="tab-provider-icon-"]').count();
    await sandboxButton.click();

    // Wait for the new sandbox tab to render.
    await expect
      .poll(async () => page.locator('[data-testid^="tab-provider-icon-"]').count(), { timeout: 15_000 })
      .toBeGreaterThan(providerIconsBefore);

    const newIcon = page.locator('[data-testid^="tab-provider-icon-"]').last();
    await expect(newIcon).toHaveAttribute('data-provider', 'shell');
    const shellId = (await newIcon.getAttribute('data-testid'))!.replace('tab-provider-icon-', '');
    const sandboxTab = page.locator(`[data-testid="tab-shell-${shellId}"]`);

    // Explicitly click the new tab — Cloud-button openShell may leave focus on
    // a previously-active tab during the first navigation roundtrip.
    await sandboxTab.click();
    await expect(sandboxTab).toHaveClass(/border-primary/, { timeout: 10_000 });

    // Scope the active-panel locator to the NEW sandbox tab so we don't read
    // from a still-visible local tab that happens to still be data-active.
    const sandboxPanel = page.locator(
      `[data-testid="terminal-panel"][data-session-id="shell-${shellId}"]`,
    );
    await expect(sandboxPanel).toHaveAttribute('data-active', 'true', { timeout: 10_000 });
    await sandboxPanel.locator('.xterm-rows').first().waitFor({ state: 'attached', timeout: 20_000 });

    // Wait for the sandbox prompt (`user@e2b` or any Linux-y prompt) — this
    // confirms E2B finished booting and bash is ready before we type.
    try {
      await expect(async () => {
        const txt = (await sandboxPanel.locator('.xterm-rows').first().textContent()) ?? '';
        expect(txt.length).toBeGreaterThan(0);
        // E2B's default PS1 includes "user@" somewhere in the first prompt line.
        expect(txt).toMatch(/user@|\$\s*$/);
      }).toPass({ timeout: 30_000 });
    } catch (e) {
      const xtermTxt = (await sandboxPanel.locator('.xterm-rows').first().textContent().catch(() => null)) ?? '<none>';
      const panelHtml = await sandboxPanel.evaluate((el) => el.outerHTML.slice(0, 2000)).catch(() => '<none>');
      // eslint-disable-next-line no-console
      console.log(`[diagnostic] sandbox panel xterm-rows textContent: ${JSON.stringify(xtermTxt)}`);
      // eslint-disable-next-line no-console
      console.log(`[diagnostic] sandbox panel outerHTML (first 2000 chars): ${panelHtml}`);
      throw e;
    }

    // Type `uname -a` exactly as a user would.
    await sandboxPanel.click();
    await page.waitForTimeout(200);
    await page.keyboard.type('uname -a', { delay: 30 });
    await page.keyboard.press('Enter');

    // Wait for "Linux" to show up in the rendered terminal output — scoped to
    // the sandbox panel only.
    await expect(async () => {
      const txt = await sandboxPanel.locator('.xterm-rows').first().textContent();
      expect(txt).toContain('Linux');
    }).toPass({ timeout: 20_000 });

    // Grab the latest non-empty line that looks like `uname -a` output — it
    // contains "Linux" and is the line AFTER the one that echoed the command.
    const fullText = (await sandboxPanel.locator('.xterm-rows').first().textContent()) ?? '';
    // Split on NBSP/space-collapsed lines and keep any that mentions Linux but
    // is not the literal command echo "uname -a".
    const candidates = fullText
      .split(/\r?\n/)
      .map((l) => l.replace(/\u00a0/g, ' ').trim())
      .filter((l) => l.includes('Linux') && !/^\$?\s*uname\s+-a\s*$/.test(l));
    const osLine = candidates[0] ?? '';

    // eslint-disable-next-line no-console
    console.log(`[sandbox-terminal-ui] uname -a → ${osLine}`);

    // Sanity: it is a real Linux line, not macOS.
    expect(osLine).toContain('Linux');
    expect(osLine).not.toContain('Darwin');
  });
});
