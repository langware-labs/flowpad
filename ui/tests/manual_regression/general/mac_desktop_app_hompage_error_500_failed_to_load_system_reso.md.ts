/**
 * App home page does not produce 500 error on macOS (FLOWPAD-1685).
 * Source: mac_desktop_app_hompage_error_500_failed_to_load_system_reso.md
 *
 * Navigate to /dock/home and assert no 500 / "failed to load system resource"
 * console error appears.
 */
import { test, expect } from '@playwright/test';

test.describe('App homepage — no 500 failed-to-load-system-resource', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('llm-setup-modal-seen', 'true');
      localStorage.setItem('flowpad-index-approved', 'true');
    });
  });

  test('test 1: App home page does not produce 500 error on macOS', async ({ page }) => {
    test.setTimeout(60_000);

    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto('/dock/home');
    // /dock/home renders the HomeLanding dock view with the "Hey <name>" greeting.
    await page.locator('h1, h2, h3').filter({ hasText: /hey /i }).first().waitFor({ state: 'visible', timeout: 25_000 });
    // Wait for the home page to load (async system-resource fetches).
    await page.waitForTimeout(3_000);

    const offending = errors.filter(
      (e) => /\b500\b/.test(e) || /failed to load system resource/i.test(e),
    );
    expect(offending, `500 / failed-to-load-system-resource console errors: ${offending.join(', ')}`).toHaveLength(0);
  });
});
