import { expect, test } from '@playwright/test';
import { withViewMode } from '../_shared/view-mode';

// Helper: dismiss the DesktopSetupModal by setting localStorage before page load
async function dismissSetupModal(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  });
}

// Helper: navigate to home and wait for the page to settle
async function gotoHome(page: import('@playwright/test').Page) {
  await dismissSetupModal(page);
// The home search surfaces asserted here (`record-search-bar`, `search-input`)
// exist only on the Standard HomeLanding — Vibe renders the creator homepage,
// which has neither. The app legitimately ends up in Vibe (the project-open path
// opens home `.withViewMode(ViewMode.Vibe)` and the dock sync persists that
// instance-wide), so a test wanting Standard must pin it on the ADDRESS rather
// than inherit whatever the instance was last left in.
  await page.goto(withViewMode('/', 'standard'));
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
}

test.describe('Record Search From Home', () => {
  // ── Test 1: Home page has a search bar ───────────────────────────────────
  test('home page has a search bar', async ({ page }) => {
    await gotoHome(page);
    const searchBar = page.locator('[data-testid="record-search-bar"]');
    await expect(searchBar).toBeVisible({ timeout: 10_000 });
  });

  // ── Test 2: Typing a query and pressing Enter navigates to search view ──
  test('typing a query and pressing Enter navigates to the search view', async ({ page }) => {
    await gotoHome(page);

    const input = page.locator('[data-testid="search-input"]').first();
    await expect(input).toBeVisible({ timeout: 10_000 });

    await input.click();
    await input.type('quarterly review');
    await input.press('Enter');

    // Wait for navigation to search view
    await expect(page).toHaveURL(/\/dock\/search/, { timeout: 10_000 });

    // URL query string should contain q=quarterly review (URL-encoded)
    await expect(page).toHaveURL(/[?&]q=quarterly(?:%20|\+)review/, { timeout: 5_000 });

    const searchView = page.locator('[data-testid="search-view"]');
    await expect(searchView).toBeVisible({ timeout: 10_000 });
  });

  // ── Test 3: Home search bar does NOT expose the Tools toggle ────────────
  // HomeLanding renders <RecordSearchBar> without showTools, so the Tools button
  // and its filter panel are intentionally hidden on the home page.
  test('home search bar does not expose the Tools toggle', async ({ page }) => {
    await gotoHome(page);

    await expect(page.locator('[data-testid="record-search-bar"]')).toBeVisible({ timeout: 10_000 });

    await expect(page.locator('[data-testid="search-tools-btn"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="search-filter-panel"]')).toHaveCount(0);
  });
});
