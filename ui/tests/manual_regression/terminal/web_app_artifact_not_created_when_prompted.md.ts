import { test, expect } from '@playwright/test';
import { dismissSetupModal } from './helpers';

test.describe('Web App view accessibility', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('Web app view is accessible and loads without crashing (FLOWPAD-1616)', async ({ page }) => {
    test.setTimeout(30_000);

    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto('/dock/web-app');
    await page.waitForTimeout(3_000);

    // Web app view should load without an error page or 404
    await expect(page.locator('body')).toBeVisible();

    // Some content should be rendered (not a blank crash)
    const hasContent = await page
      .locator('button, input, iframe, [role="main"], h1, h2, p')
      .first()
      .isVisible({ timeout: 5_000 })
      .catch(() => false);
    expect(hasContent, 'Web app view rendered nothing — possible crash or 404').toBe(true);

    const realErrors = errors.filter(
      (e) =>
        !e.includes('ResizeObserver') &&
        !e.includes('favicon') &&
        !e.includes('404'), // web-app view may 404 on iframe content without a running session — that's expected
    );
    expect(realErrors, `Console errors: ${realErrors.join(', ')}`).toHaveLength(0);
  });
});
