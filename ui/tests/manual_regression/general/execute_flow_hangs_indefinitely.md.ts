import { test, expect } from '@playwright/test';

test.describe('Execute Flow view', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('llm-setup-modal-seen', 'true');
    });
  });

  test('Execute flow view loads and is responsive (FLOWPAD-1662)', async ({ page }) => {
    test.setTimeout(60_000);

    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto('/dock/execute-flow');
    // Wait for the React app root to mount; retry if HMR is still settling
    await page.locator('[data-testid="flow-page"]').waitFor({ state: 'visible', timeout: 25_000 });

    // View should be visible and not stuck in a loading state
    await expect(page.locator('body')).toBeVisible();

    // At least one interactive control should be visible (button, input, or list)
    const hasInteractiveControl = await page
      .locator('button, input, [role="listitem"], [role="button"]')
      .first()
      .isVisible({ timeout: 10_000 })
      .catch(() => false);
    expect(hasInteractiveControl, 'No interactive control found in execute-flow view').toBe(true);

    const realErrors = errors.filter(
      (e) => !e.includes('ResizeObserver') && !e.includes('favicon'),
    );
    expect(realErrors, `Console errors: ${realErrors.join(', ')}`).toHaveLength(0);
  });
});
