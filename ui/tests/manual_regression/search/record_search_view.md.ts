import { expect, test } from '@playwright/test';
import { apiBase } from '../_shared/api';

async function dismissSetupModal(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  });
}

test.describe('Record Search View (/dock/search)', () => {
  // ── Test 1: Search view accessible without a query ─────────────────────────
  test('Search view is accessible at /dock/search without a query', async ({ page }) => {
    await dismissSetupModal(page);
    await page.goto('/dock/search');
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

    const searchView = page.locator('[data-testid="search-view"]');
    await expect(searchView).toBeVisible({ timeout: 10_000 });
  });

  // ── Test 2: URL param ?q=hello pre-populates the search input value ────────
  test('URL param ?q=hello pre-populates the search input value', async ({ page }) => {
    await dismissSetupModal(page);
    await page.goto('/dock/search?q=hello');
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

    const input = page.locator('[data-testid="search-input"]').first();
    await expect(input).toBeVisible({ timeout: 10_000 });
    await expect(input).toHaveValue('hello', { timeout: 5_000 });
  });

  // ── Test 3: Results area is always visible in the search view ──────────────
  test('Results area is always visible in the search view', async ({ page }) => {
    await dismissSetupModal(page);
    await page.goto('/dock/search?q=test');
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

    const results = page.locator('[data-testid="search-results"]');
    await expect(results).toBeVisible({ timeout: 10_000 });
  });

  // ── Test 4: Backend search API returns a valid JSON response ───────────────
  test('Backend search API returns a valid JSON response', async ({ page }) => {
    const apiUrl = apiBase();
    const response = await page.request.get(`${apiUrl}/api/v1/search?q=test&limit=5`);
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('SUCCESS');
    expect(body.data).toBeDefined();
    expect(Array.isArray(body.data.results)).toBe(true);
    expect(typeof body.data.indexer_ready).toBe('boolean');
  });
});
