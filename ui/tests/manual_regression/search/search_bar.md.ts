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
  // Wait for initial render — look for something stable
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
}

test.describe('Record Search Bar', () => {
  // ── Test 1: Home page has search bar ──────────────────────────────────────
  test('home page has a search bar', async ({ page }) => {
    await gotoHome(page);
    const searchBar = page.locator('[data-testid="record-search-bar"]');
    await expect(searchBar).toBeVisible({ timeout: 10_000 });
  });

  // ── Test 2: Enter navigates to search view ────────────────────────────────
  test('pressing Enter from home search bar navigates to search view', async ({ page }) => {
    await gotoHome(page);

    const input = page.locator('[data-testid="search-input"]').first();
    await expect(input).toBeVisible({ timeout: 10_000 });

    await input.click();
    await input.fill('quarterly review');
    await input.press('Enter');

    // URL should contain /dock/search
    await expect(page).toHaveURL(/\/dock\/search/, { timeout: 10_000 });

    // Search view element should appear
    const searchView = page.locator('[data-testid="search-view"]');
    await expect(searchView).toBeVisible({ timeout: 10_000 });
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

    const searchBar = page.locator('[data-testid="record-search-bar"]');
    await expect(searchBar).toBeVisible({ timeout: 10_000 });

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
