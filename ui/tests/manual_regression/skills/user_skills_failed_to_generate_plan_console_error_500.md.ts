/**
 * Skills view loads without 500 console errors (FLOWPAD-1664).
 * Source: user_skills_failed_to_generate_plan_console_error_500.md
 */
import { test, expect } from '@playwright/test';

test.describe('Skills view — no 500', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('llm-setup-modal-seen', 'true');
      localStorage.setItem('flowpad-index-approved', 'true');
    });
  });

  test('test 1: Skills view loads without 500 console errors', async ({ page }) => {
    test.setTimeout(60_000);

    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto('/dock/assets/list/skill');
    await page.waitForLoadState('networkidle', { timeout: 25_000 }).catch(() => {});
    await expect(page.locator('#root')).not.toBeEmpty();
    expect(page.url()).toContain('/dock/assets/list/skill');
    await page.waitForTimeout(3_000);

    const offending = errors.filter((e) => /\b500\b/.test(e));
    expect(offending, `500 console errors in skills view: ${offending.join(', ')}`).toHaveLength(0);
  });
});
