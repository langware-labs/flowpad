import { expect, test } from '@playwright/test';

// Helper: dismiss the DesktopSetupModal by setting localStorage before page load
async function dismissSetupModal(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  });
}

// Helper: navigate to home and wait for the page to settle
// The home is Vibe-only (UNSTATED_VIEW_MODE; the standard HomeLanding with `record-search-bar` /
// `search-input` stays mounted but `display:none`), so home search is the address bar's search
// pill: `top-nav-search-open` -> `top-nav-search-input`, with a results popover (no Enter -> /dock/search).
async function gotoHome(page: import('@playwright/test').Page) {
  await dismissSetupModal(page);
  await page.goto('/');
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  await page.locator('[data-testid="top-nav-search-open"]').waitFor({ timeout: 20_000 });
}

async function openTopNavSearch(page: import('@playwright/test').Page) {
  await page.locator('[data-testid="top-nav-search-open"]').click();
  const input = page.locator('[data-testid="top-nav-search-input"]');
  await expect(input).toBeVisible({ timeout: 10_000 });
  return input;
}

test.describe('Record Search Bar', () => {
  // ── Test 1: Home page has search bar ──────────────────────────────────────
  test('home page has a search bar', async ({ page }) => {
    await gotoHome(page);
    await expect(page.locator('[data-testid="top-nav-search-open"]')).toBeVisible({ timeout: 10_000 });
    await openTopNavSearch(page);
  });

  // ── Test 2: Enter navigates to search view ────────────────────────────────
  test('typing in the home search bar opens the results popover', async ({ page }) => {
    await gotoHome(page);
    const input = await openTopNavSearch(page);
    await input.fill('quarterly review');
    await expect(page.locator('[data-testid="top-nav-search-results"]')).toBeVisible({ timeout: 10_000 });
  });

  // ── Test 3: URL query param pre-populates the search input ────────────────
  test('navigating to /dock/search?q=hello pre-populates the search input', async ({ page }) => {
    await page.goto('/dock/search?q=hello');
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

    const input = page.locator('[data-testid="search-input"]').first();
    await expect(input).toBeVisible({ timeout: 10_000 });
    await expect(input).toHaveValue('hello', { timeout: 5_000 });
  });

  // ── Test 4: Compact home bar has no Tools button / filter panel ───────────
  test('compact home search bar has no Tools button and no filter panel', async ({ page }) => {
    await gotoHome(page);

    await openTopNavSearch(page);

    // Home bar is rendered with default showTools=false → no Tools button
    const toolsBtn = page.locator('[data-testid="search-tools-btn"]');
    await expect(toolsBtn).toHaveCount(0);

    // No filter panel initially (compact=true by default)
    const filterPanel = page.locator('[data-testid="search-filter-panel"]');
    await expect(filterPanel).toHaveCount(0);
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
