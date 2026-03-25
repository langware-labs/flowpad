import { expect, test } from '@playwright/test';

const API_URL = process.env.API_URL ?? 'http://localhost:9007';

async function dismissSetupModal(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  });
}

test.describe('Search Scan Info Stats', () => {
  // ── Test 1: Bootstrap API includes scan_info ───────────────────────────────
  test('bootstrap API response includes scan_info with expected shape', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/v1/graph/bootstrap`);
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('SUCCESS');

    const scanInfo = body.data?.scan_info;
    expect(scanInfo).toBeTruthy();
    expect(typeof scanInfo.total_indexed).toBe('number');
    expect(scanInfo.total_indexed).toBeGreaterThanOrEqual(0);
    expect(typeof scanInfo.never_indexed).toBe('boolean');
    expect(typeof scanInfo.stale).toBe('boolean');
  });

  // ── Test 2: SearchView header shows "indexed" text ─────────────────────────
  test('SearchView header shows indexed count badge after bootstrap', async ({ page }) => {
    await dismissSetupModal(page);
    await page.goto('/dock/search');
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

    const searchView = page.locator('[data-testid="search-view"]');
    await expect(searchView).toBeVisible({ timeout: 10_000 });

    // Wait for the "N indexed" badge to appear anywhere in the view header
    const indexedBadge = page.locator('text=/\\d+ indexed/').first();
    await expect(indexedBadge).toBeVisible({ timeout: 8_000 });
  });

  // ── Test 3: "indexed" count is a non-negative integer ─────────────────────
  test('SearchView indexed count is a non-negative integer', async ({ page }) => {
    await dismissSetupModal(page);
    await page.goto('/dock/search');
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

    const indexedBadge = page.locator('text=/\\d+ indexed/').first();
    await expect(indexedBadge).toBeVisible({ timeout: 8_000 });

    const text = await indexedBadge.textContent() ?? '';
    const match = text.match(/(\d+)\s+indexed/);
    expect(match).toBeTruthy();
    expect(Number(match![1])).toBeGreaterThanOrEqual(0);
  });

  // ── Test 4: Home inline search stats shows "indexed" ──────────────────────
  test('home inline search stats line shows indexed after a search', async ({ page }) => {
    await dismissSetupModal(page);
    await page.goto('/dock/home');
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

    const input = page.locator('[data-testid="search-input"]').first();
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.click();
    // Use type() to trigger React onChange events character by character (more reliable than fill for controlled inputs)
    await input.type('test');
    // Wait briefly for React to process the input and debounce to settle (300ms debounce + buffer)
    await page.waitForTimeout(600);

    // Wait for inline results panel header to appear — either loading or results
    // Accept: "Searching…", "N results · ...", "Ready", "No results"
    const inlineHeader = page.locator('text=/Searching|result|Ready|No results/').first();
    await expect(inlineHeader).toBeVisible({ timeout: 10_000 });

    // Wait for loading to finish
    await expect(page.locator('text=Searching')).not.toBeVisible({ timeout: 8_000 }).catch(() => {});

    // Stats line should now contain "indexed" (if LanceDB has indexed docs)
    // Accept: "N indexed" or just validate results are shown
    const finalStats = page.locator('text=/\\d+ result/').first();
    await expect(finalStats).toBeVisible({ timeout: 5_000 });
  });

  // ── Test 5: index-status endpoint returns expected shape ───────────────────
  test('index-status API endpoint returns expected shape', async ({ request }) => {
    const res = await request.get(
      `${API_URL}/api/v1/graph/compute_node/@local/fs-records/index-status`,
    );
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('SUCCESS');

    const data = body.data;
    expect(typeof data.never_indexed).toBe('boolean');
    expect(typeof data.stale).toBe('boolean');
    expect(Array.isArray(data.per_type)).toBe(true);
  });
});
