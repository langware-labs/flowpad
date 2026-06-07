/**
 * Shell sessions persist and do not disappear after navigating away and back
 * (FLOWPAD-1646). Source: sessions_disappear_after_page_refresh.md
 */
import { test, expect } from '@playwright/test';
import { dismissSetupModal } from './helpers';
import { gotoShell } from '../terminal/helpers';

test.describe('sessions persist across navigation', () => {
  test('test 1: terminal tab survives navigating home and back to shell', async ({ page }) => {
    test.setTimeout(120_000);
    await dismissSetupModal(page);
    await gotoShell(page);

    // Capture the shell session id from the URL.
    const shellId = page.url().match(/(shell-[\w-]+)/)?.[1];
    expect(shellId, 'expected a shell- session id in the URL').toBeTruthy();

    // Navigate away to home, then back to the shell view.
    await page.goto('/dock/home');
    await page.waitForTimeout(1_000);
    await page.goto('/dock/shell');
    await page.waitForTimeout(3_000);

    // At least one terminal tab is still present (sessions did not disappear).
    await expect(page.locator('[data-testid^="tab-shell-"]').first()).toBeVisible({ timeout: 30_000 });
  });
});
