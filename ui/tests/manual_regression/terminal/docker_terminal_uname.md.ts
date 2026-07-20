/**
 * Docker Terminal — uname -s end-to-end
 *
 * Drives the docker terminal via the UI the way a user would:
 *   1. Open the Shell view.
 *   2. Click a [data-testid^="open-docker-tab-button-"] toolbar button.
 *   3. Wait for the new docker tab to become active.
 *   4. Type `uname -s` into xterm.js.
 *   5. Expect `Linux` to appear (container kernel, not host macOS).
 *
 * Auto-skips when the backend has no registered docker workers (run
 * `flow compute connect <container> --start` on the host to enable).
 */
import { expect, test } from '@playwright/test';
import { dismissSetupModal, gotoShell } from './helpers';

test.describe('Docker terminal — uname -s', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('user clicks docker button and sees Linux in the xterm', async ({ page }) => {
    test.setTimeout(90_000);

    await gotoShell(page);

    // Find any per-container docker button. Skip if none.
    const dockerButton = page.locator('[data-testid^="open-docker-tab-button-"]').first();
    if (!(await dockerButton.isVisible({ timeout: 2_000 }).catch(() => false))) {
      test.skip(true, 'No registered docker workers. Run `flow compute connect <container> --start` first.');
    }

    // Click to open a fresh docker tab.
    const tabCountBefore = await page.locator('[data-testid^="tab-shell-"]').count();
    await dockerButton.click();

    // A new shell tab must appear.
    await expect
      .poll(async () => page.locator('[data-testid^="tab-shell-"]').count(), { timeout: 15_000 })
      .toBeGreaterThan(tabCountBefore);

    // The newly-active panel corresponds to the just-opened shell. We grab its
    // session id from data-active="true" (scoped to the most-recently-added tab).
    const activePanel = page.locator('[data-testid="terminal-panel"][data-active="true"]').first();
    await expect(activePanel).toBeVisible({ timeout: 10_000 });
    await activePanel.locator('.xterm-rows').first().waitFor({ state: 'attached', timeout: 15_000 });

    // Wait for a bash-ish prompt before typing (container cold-start + PTY attach).
    await expect(async () => {
      const txt = (await activePanel.locator('.xterm-rows').first().textContent()) ?? '';
      expect(txt.length).toBeGreaterThan(0);
      expect(txt).toMatch(/\$\s*$|#\s*$|>\s*$/);
    }).toPass({ timeout: 20_000 });

    // Type `uname -s` one keystroke at a time (xterm.js needs real keyboard events).
    await activePanel.click();
    await page.waitForTimeout(200);
    await page.keyboard.type('uname -s', { delay: 30 });
    await page.keyboard.press('Enter');

    // Wait for Linux in the xterm output.
    await expect(async () => {
      const txt = await activePanel.locator('.xterm-rows').first().textContent();
      expect(txt).toContain('Linux');
    }).toPass({ timeout: 20_000 });

    const fullText = (await activePanel.locator('.xterm-rows').first().textContent()) ?? '';
    // eslint-disable-next-line no-console
    console.log(`[docker-terminal-ui] tail: ${fullText.slice(-300)}`);
    // Must be from the container, not the host.
    expect(fullText).toContain('Linux');
    expect(fullText).not.toContain('Darwin');
  });
});
