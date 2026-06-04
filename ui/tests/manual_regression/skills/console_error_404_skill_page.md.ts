/**
 * Skills view loads without 404 console errors (FLOWPAD-1661).
 * Source: console_error_404_skill_page.md
 *
 * Skills are folded into the unified Assets browser at /dock/assets/list/skill.
 */
import { test, expect } from '@playwright/test';

test.describe('Skills view — no 404', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('llm-setup-modal-seen', 'true');
      localStorage.setItem('flowpad-index-approved', 'true');
    });
  });

  test('test 1: Skills view loads without 404 console errors', async ({ page }) => {
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

    // 404s from a stale user typeid after DB clear, or the cross-cutting
    // agent_hook/<id>/watch noise, are unrelated to this view regression.
    const offending = errors.filter(
      (e) =>
        /\b404\b/.test(e) &&
        !/user-/.test(e) &&
        !/agent_hook/.test(e),
    );
    expect(offending, `404 console errors in skills view: ${offending.join(', ')}`).toHaveLength(0);
  });
});
