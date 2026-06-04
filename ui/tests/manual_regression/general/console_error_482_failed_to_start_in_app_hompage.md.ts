/**
 * console error 482 "failed to start" in app homepage (FLOWPAD-1660).
 * Source: console_error_482_failed_to_start_in_app_hompage.md
 *
 * Navigate to the app homepage and assert no "failed to start" / 482 console
 * error appears (the regression this scenario guards).
 */
import { test, expect } from '@playwright/test';

test.describe('App homepage — no 482 failed-to-start', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('llm-setup-modal-seen', 'true');
      localStorage.setItem('flowpad-index-approved', 'true');
    });
  });

  test('test 1: app homepage loads without 482 "failed to start" console error', async ({ page }) => {
    test.setTimeout(60_000);

    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto('/dock/home');
    // /dock/home renders the HomeLanding dock view with the "Hey <name>" greeting.
    await page.locator('h1, h2, h3').filter({ hasText: /hey /i }).first().waitFor({ state: 'visible', timeout: 25_000 });
    // Let async homepage fetches settle so a late 482 would surface.
    await page.waitForTimeout(3_000);

    const offending = errors.filter((e) => /failed to start|\b482\b/i.test(e));
    expect(offending, `482/failed-to-start console errors: ${offending.join(', ')}`).toHaveLength(0);
  });
});
