/**
 * Skills list loads without 404 console errors (FLOWPAD-1665).
 * Source: user_skills_failed_to_generate_plan_console_error_404.md
 *
 * Skills are folded into the unified Assets browser at /dock/assets/list/skill.
 * The FLOWPAD-1665 shape is a /api/v1/graph/plan/<id> 404; the cross-cutting
 * agent_hook/<id>/watch 404 noise is its own ticket and is filtered out.
 */
import { test, expect } from '@playwright/test';

test.describe('Skills list — no FLOWPAD-1665 plan 404', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('llm-setup-modal-seen', 'true');
    });
  });

  test('test 1: Skills list loads without 404 console errors', async ({ page }) => {
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

    // FLOWPAD-1665-shaped 404 = /api/v1/graph/plan/<id>. Filter the cross-cutting
    // agent_hook/<id>/watch noise (its own ticket) and stale-user 404s.
    const offending = errors.filter(
      (e) =>
        /\b404\b/.test(e) &&
        !/agent_hook/.test(e) &&
        !/user-/.test(e),
    );
    expect(offending, `404 console errors in skills list: ${offending.join(', ')}`).toHaveLength(0);
  });
});
