import { test, expect } from '@playwright/test';

test.describe('LLM configuration view', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('llm-setup-modal-seen', 'true');
    });
  });

  test('AI configuration view is accessible and loads without errors (FLOWPAD-1604)', async ({ page }) => {
    test.setTimeout(60_000);

    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto('/dock/ai-config');
    // SDK bootstrap makes multiple API calls and React lazy-loads modules.
    // Wait 15s for the app to fully render before checking for interactive elements.
    await page.waitForTimeout(15_000);

    // The AI config view should be visible
    await expect(page.locator('body')).toBeVisible();

    // At least one configuration option should be visible
    const hasContent = await page
      .locator('button, input, select, [role="option"]')
      .first()
      .isVisible({ timeout: 10_000 })
      .catch(() => false);
    expect(hasContent, 'AI config view appears empty or stuck').toBe(true);

    const realErrors = errors.filter(
      (e) => !e.includes('ResizeObserver') && !e.includes('favicon'),
    );
    expect(realErrors, `Console errors: ${realErrors.join(', ')}`).toHaveLength(0);
  });

  test('Navigating back to home after visiting AI config shows no crash', async ({ page }) => {
    test.setTimeout(60_000);

    await page.goto('/dock/ai-config');
    await page.waitForTimeout(2_000);

    await page.goto('/dock/home');
    // Wait for the home page to finish loading — the AgentLayout may take several seconds
    // to initialize (especially if SDK bootstrap is in progress).
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(2_000);

    // Home landing should be visible and functional
    await expect(page.locator('body')).toBeVisible();

    // App remains functional (search bar or session input visible)
    const hasInteractiveElement = await page
      .locator('input, button, textarea')
      .first()
      .isVisible({ timeout: 10_000 })
      .catch(() => false);
    expect(hasInteractiveElement, 'Home page appears broken after returning from AI config').toBe(true);
  });
});
