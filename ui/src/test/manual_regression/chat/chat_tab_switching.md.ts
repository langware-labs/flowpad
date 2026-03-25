import { test, expect } from '@playwright/test';
import { dismissSetupModal, gotoLanding, submitFromLanding, ensureActiveSession } from './helpers';

test.describe('Chat Tab Switching', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('switch between sidebar dock views', async ({ page }) => {
    test.setTimeout(90_000);

    await gotoLanding(page);
    await submitFromLanding(page, 'tab switching test');
    await ensureActiveSession(page);

    // We're now in a session at /dock/session/...
    expect(page.url()).toMatch(/\/dock\/session\//);

    // Navigate to shell view via URL (sidebar button order can change)
    await page.goto('/dock/shell/new_terminal');
    await page.waitForURL(/\/dock\/shell\/shell-/, { timeout: 15_000 });
    expect(page.url()).toMatch(/\/dock\/shell/);

    // Click Home (first sidebar button) to return to landing
    await page.locator('ul li button').first().click();
    await page.waitForURL(/^\/$|\/$/, { timeout: 10_000 });
    await expect(page.getByRole('heading', { name: /hey /i })).toBeVisible();
  });
});
