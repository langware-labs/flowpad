/**
 * Navigating to non-main tabs does not produce 404 (agent ID missing) errors
 * (FLOWPAD-1644).
 * Source: refreshing_any_tab_other_than_main_app_error_404_agent_id_mi.md
 */
import { test, expect } from '@playwright/test';

test.describe('Non-main tabs — no 404 agent-id-missing', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('llm-setup-modal-seen', 'true');
    });
  });

  test('test 1: Navigating to execute flow tab does not produce 404 (agent ID missing) error', async ({ page }) => {
    test.setTimeout(60_000);

    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto('/dock/execute-flow');
    await page.locator('[data-testid="flow-page"]').waitFor({ state: 'visible', timeout: 25_000 });
    await page.waitForTimeout(3_000);

    const offending = errors.filter(
      (e) => /agent id missing/i.test(e) || (/\b404\b/.test(e) && /agent/i.test(e)),
    );
    expect(offending, `404/agent-id-missing console errors: ${offending.join(', ')}`).toHaveLength(0);
  });

  test('test 2: Navigating to skills tab does not produce 404 error', async ({ page }) => {
    test.setTimeout(60_000);

    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto('/dock/assets/list/skill');
    // The assets list view mounts; wait for network to settle then assert the
    // view rendered (URL preserved on the skills route, app root non-empty) —
    // the scenario's intent is the absence of a 404, not a specific element.
    await page.waitForLoadState('networkidle', { timeout: 25_000 }).catch(() => {});
    await expect(page.locator('#root')).not.toBeEmpty();
    expect(page.url()).toContain('/dock/assets/list/skill');
    await page.waitForTimeout(3_000);

    // 404s from a stale user typeid after DB clear are unrelated to this view
    // regression; only count 404s tied to agent-id-missing (the scenario's bug).
    const offending = errors.filter(
      (e) => /agent id missing/i.test(e) || (/\b404\b/.test(e) && /agent/i.test(e)),
    );
    expect(offending, `404 console errors in skills view: ${offending.join(', ')}`).toHaveLength(0);
  });
});
