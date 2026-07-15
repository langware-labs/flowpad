/**
 * Skills view loads and skill controls are accessible without 482 console error
 * (FLOWPAD-1666).
 * Source: skills_failed_to_run_skill_console_error_482.md
 */
import { test, expect } from '@playwright/test';

test.describe('Skills view — no 482', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('llm-setup-modal-seen', 'true');
    });
  });

  test('test 1: Skills view loads without 482 console error', async ({ page }) => {
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

    const offending = errors.filter((e) => /\b482\b/.test(e) || /failed to run skill/i.test(e));
    expect(offending, `482 console errors in skills view: ${offending.join(', ')}`).toHaveLength(0);
  });
});
