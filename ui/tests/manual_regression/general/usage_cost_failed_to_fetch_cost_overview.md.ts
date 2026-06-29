/**
 * Home page loads usage and cost overview without errors (FLOWPAD-1674).
 * Source: usage_cost_failed_to_fetch_cost_overview.md
 *
 * Navigate to /dock/home and assert no "failed to fetch cost overview" console
 * error appears.
 */
import { test, expect } from '@playwright/test';

test.describe('Home usage/cost overview — no fetch error', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('llm-setup-modal-seen', 'true');
      localStorage.setItem('flowpad-index-approved', 'true');
    });
  });

  test('test 1: Home page loads usage and cost overview without errors', async ({ page }) => {
    test.setTimeout(60_000);

    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto('/dock/home');
    // /dock/home renders the HomeLanding dock view with the "Hey <name>" greeting.
    await page.locator('h1, h2, h3').filter({ hasText: /hey /i }).first().waitFor({ state: 'visible', timeout: 25_000 });
    // Wait for the cost/usage overview fetch to resolve.
    await page.waitForTimeout(3_000);

    const offending = errors.filter((e) => /failed to fetch cost overview/i.test(e));
    expect(offending, `cost-overview fetch errors: ${offending.join(', ')}`).toHaveLength(0);
  });
});
