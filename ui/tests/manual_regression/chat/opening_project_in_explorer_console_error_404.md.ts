/**
 * Opening the file explorer (Files tab) does not produce 404 console errors
 * (FLOWPAD-1643). Source: opening_project_in_explorer_console_error_404.md
 */
import { test, expect } from '@playwright/test';
import { dismissSetupModal } from './helpers';

test.describe('explorer — no 404', () => {
  test('test 1: opening the file explorer produces no 404 console errors', async ({ page }) => {
    test.setTimeout(60_000);
    const consoleErrors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

    await dismissSetupModal(page);
    await page.goto('/dock/explorer');
    await page.waitForURL(/\/dock\/explorer/, { timeout: 15_000 });
    await page.waitForTimeout(3_000);

    // The explorer view rendered (the dock content area mounted, not a blank /
    // error page). The explorer tree itself carries no testid, so assert the
    // app shell + a non-trivial DOM rather than a specific tree node.
    await expect(page.locator('#root, [data-dock], main').first()).toBeVisible({ timeout: 15_000 });
    const bodyText = (await page.locator('body').innerText().catch(() => '')) ?? '';
    expect(bodyText.length).toBeGreaterThan(0);

    // The regression under test: no 404 console errors on explorer load.
    const notFound = consoleErrors.filter((e) => /\b404\b|not found/i.test(e));
    expect(notFound, notFound.join('\n')).toHaveLength(0);
  });
});
