/**
 * Shell terminal starts and is ready within 15 seconds (FLOWPAD-1614).
 * Source: shell_starts_in_acceptable_time.md
 *
 * Navigates to /dock/shell/new_terminal and asserts the active xterm panel +
 * terminal input become ready within a hard 15s budget. The 15s cap encodes the
 * scenario intent ("ready within 15 seconds") — it is the assertion, not a
 * convenience timeout, and must not be widened.
 */
import { test, expect } from '@playwright/test';
import { dismissSetupModal } from './helpers';

test.describe('Shell starts in acceptable time', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('test 1: Shell terminal starts and is ready within 15 seconds', async ({ page }) => {
    // Step 1: navigate to /dock/shell/new_terminal. Start the clock at navigation.
    const start = Date.now();
    await page.goto('/dock/shell/new_terminal');

    // Dismiss any setup/welcome modal that could block readiness.
    const skip = page.getByRole('button', { name: 'Skip' });
    if (await skip.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await skip.click();
    }

    // Step 2: wait for terminal to be ready — active terminal panel shows xterm,
    // within 15s of navigation.
    await page
      .locator('[data-testid="terminal-panel"][data-active="true"] .xterm-rows')
      .first()
      .waitFor({ state: 'attached', timeout: 15_000 });
    const elapsed = Date.now() - start;

    // Step 3: validate terminal input is visible (aria-label="Terminal input").
    await expect(page.locator('[aria-label="Terminal input"]').first()).toBeVisible({ timeout: 15_000 });

    // Step 4: validate the terminal rendered within 15 seconds of navigation.
    expect(elapsed, `terminal ready in ${elapsed}ms (budget 15000ms)`).toBeLessThanOrEqual(15_000);
  });
});
