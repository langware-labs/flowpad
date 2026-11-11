import { expect, test } from '@playwright/test';
import { adjusted } from '../../adjustableTimeout';

// Since 2026-10-11 the home is always the tabless Vibe hero (docs/viewmodes.md):
// it carries no record search bar. Searching starts in the search view
// (/dock/search), whose bar writes the query to the URL as it is typed.

// Helper: dismiss the DesktopSetupModal by setting localStorage before page load
async function dismissSetupModal(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  });
}

async function gotoHome(page: import('@playwright/test').Page) {
  await dismissSetupModal(page);
  await page.goto('/');
  await page.waitForLoadState('networkidle', { timeout: adjusted(20_000) }).catch(() => {});
}

test.describe('Record Search From Home', () => {
  // ── Test 1: Home is the Vibe hero; the search bar is in the search view ──
  test('home is the Vibe hero and the record search bar is in the search view', async ({ page }) => {
    await gotoHome(page);
    await expect(page.locator('html')).toHaveAttribute('data-view', 'vibe', { timeout: adjusted(15_000) });
    await expect(page.locator('[data-testid="record-search-bar"]:visible')).toHaveCount(0);

    await page.goto('/dock/search');
    await expect(page.locator('[data-testid="record-search-bar"]:visible')).toBeVisible({ timeout: adjusted(10_000) });
  });

  // ── Test 2: A typed query lands in the search view's URL ─────────────────
  test('typing a query in the search view puts it in the URL', async ({ page }) => {
    await dismissSetupModal(page);
    await page.goto('/dock/search');

    const input = page.locator('[data-testid="search-input"]:visible').first();
    await expect(input).toBeVisible({ timeout: adjusted(10_000) });

    await input.click();
    await input.fill('quarterly review');

    await expect(page).toHaveURL(/\/dock\/search/, { timeout: adjusted(10_000) });
    await expect(page).toHaveURL(/[?&]q=quarterly(?:%20|\+)review/, { timeout: adjusted(10_000) });
    await expect(page.locator('[data-testid="search-view"]')).toBeVisible({ timeout: adjusted(10_000) });
  });

  // ── Test 3: Home exposes no search Tools toggle or filter panel ──────────
  test('home exposes no search Tools toggle or filter panel', async ({ page }) => {
    await gotoHome(page);
    await expect(page.locator('html')).toHaveAttribute('data-view', 'vibe', { timeout: 15_000 });

    await expect(page.locator('[data-testid="search-tools-btn"]:visible')).toHaveCount(0);
    await expect(page.locator('[data-testid="search-filter-panel"]:visible')).toHaveCount(0);
  });
});
