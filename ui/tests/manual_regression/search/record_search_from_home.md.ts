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

test.describe('Record Search From Home', () => {
  // ── Test 1: Home page has a search bar ───────────────────────────────────
  test('home page has a search bar', async ({ page }) => {
    await gotoHome(page);
    await openTopNavSearch(page);
  });

  // ── Test 2: Typing a query and pressing Enter navigates to search view ──
  test('typing a query opens the results popover', async ({ page }) => {
    await gotoHome(page);
    const input = await openTopNavSearch(page);
    await input.fill('quarterly review');
    await expect(page.locator('[data-testid="top-nav-search-results"]')).toBeVisible({ timeout: 10_000 });
  });

  // ── Test 3: Home search bar does NOT expose the Tools toggle ────────────
  // HomeLanding renders <RecordSearchBar> without showTools, so the Tools button
  // and its filter panel are intentionally hidden on the home page.
  test('home search bar does not expose the Tools toggle', async ({ page }) => {
    await gotoHome(page);

    await openTopNavSearch(page);

    await expect(page.locator('[data-testid="search-tools-btn"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="search-filter-panel"]')).toHaveCount(0);
  });
});
