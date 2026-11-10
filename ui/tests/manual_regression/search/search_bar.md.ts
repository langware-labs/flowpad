import { expect, test } from '@playwright/test';

// Helper: dismiss the DesktopSetupModal by setting localStorage before page load
async function dismissSetupModal(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  });
}

// Helper: navigate to home and wait for the page to settle. Since 2026-10-11 the
// home is always the tabless Vibe hero (docs/viewmodes.md): it carries no search
// bar. The record search bar lives in the search view (/dock/search).
async function gotoHome(page: import('@playwright/test').Page) {
  await dismissSetupModal(page);
  await page.goto('/');
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
}

test.describe('Record Search Bar', () => {
  // ── Test 1: Home is the Vibe hero; the search bar lives in the search view ──
  test('home is the Vibe hero and the search bar lives in the search view', async ({ page }) => {
    await gotoHome(page);
    await expect(page.locator('html')).toHaveAttribute('data-view', 'vibe', { timeout: 15_000 });
    await expect(page.locator('[data-testid="record-search-bar"]:visible')).toHaveCount(0);

    await page.goto('/dock/search');
    const searchBar = page.locator('[data-testid="record-search-bar"]:visible');
    await expect(searchBar).toBeVisible({ timeout: 10_000 });
  });

  // ── Test 2: Typing in the search view writes the query to the URL ─────────
  test('typing in the search view writes the query to the URL', async ({ page }) => {
    await dismissSetupModal(page);
    await page.goto('/dock/search');

    const input = page.locator('[data-testid="search-input"]:visible').first();
    await expect(input).toBeVisible({ timeout: 10_000 });

    await input.click();
    await input.fill('quarterly review');

    await expect(page).toHaveURL(/\/dock\/search\?.*q=quarterly/, { timeout: 10_000 });
    await expect(page.locator('[data-testid="search-view"]')).toBeVisible({ timeout: 10_000 });
  });

  // ── Test 3: URL query param pre-populates the search input ────────────────
  test('navigating to /dock/search?q=hello pre-populates the search input', async ({ page }) => {
    await page.goto('/dock/search?q=hello');
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

    const input = page.locator('[data-testid="search-input"]').first();
    await expect(input).toBeVisible({ timeout: 10_000 });
    await expect(input).toHaveValue('hello', { timeout: 5_000 });
  });

  // ── Test 4: The search view bar is the full bar: filters open, no Tools ───
  test('search view bar shows its filter panel and no Tools button', async ({ page }) => {
    await dismissSetupModal(page);
    await page.goto('/dock/search');

    const searchBar = page.locator('[data-testid="record-search-bar"]:visible');
    await expect(searchBar).toBeVisible({ timeout: 10_000 });

    // The search view renders the bar with compact=false (filters shown) and
    // the default showTools=false (no Tools button).
    await expect(searchBar.locator('[data-testid="search-filter-panel"]')).toBeVisible({ timeout: 10_000 });
    await expect(searchBar.locator('[data-testid="search-tools-btn"]')).toHaveCount(0);
  });

  // ── Test 5: Search results area renders in search view ────────────────────
  test('search view shows results area', async ({ page }) => {
    await page.goto('/dock/search?q=test');
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

    const results = page.locator('[data-testid="search-results"]');
    await expect(results).toBeVisible({ timeout: 10_000 });
  });

  // ── Test 6: Search view exists at /dock/search (empty query) ─────────────
  test('search view is accessible without a query', async ({ page }) => {
    await page.goto('/dock/search');
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

    const searchView = page.locator('[data-testid="search-view"]');
    await expect(searchView).toBeVisible({ timeout: 10_000 });
  });
});
