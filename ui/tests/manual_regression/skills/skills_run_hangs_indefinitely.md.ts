import { test, expect } from '@playwright/test';

test.describe('Skills view', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('llm-setup-modal-seen', 'true');
    });
  });

  test('Skills view is responsive and does not hang indefinitely (FLOWPAD-1667)', async ({ page }) => {
    test.setTimeout(60_000);

    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto('/dock/skills');
    // SDK bootstrap makes multiple API calls and React lazy-loads modules.
    // Wait 15s for the app to fully render before checking for interactive elements.
    await page.waitForTimeout(15_000);

    // Skills view should be visible
    await expect(page.locator('body')).toBeVisible();

    // Should not be stuck in an indefinite loading state — at least one button should be visible
    const hasButton = await page
      .locator('button')
      .first()
      .isVisible({ timeout: 5_000 })
      .catch(() => false);
    expect(hasButton, 'No button found — skills view may be stuck loading').toBe(true);

    const realErrors = errors.filter(
      (e) =>
        !e.includes('ResizeObserver') &&
        !e.includes('favicon') &&
        // Stale user typeid from a prior session can 404 after DB clear — not
        // a Skills-view regression. Filter both the raw 404 and the SDK
        // wrapper error that surfaces it.
        !e.includes('404') &&
        !e.includes('Error fetching entity by type ID: user-'),
    );
    expect(realErrors, `Console errors: ${realErrors.join(', ')}`).toHaveLength(0);
  });
});
