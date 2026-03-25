import { expect, test } from '@playwright/test';

const API_URL = process.env.API_URL ?? 'http://localhost:9007';
const CN_FS_BASE = `${API_URL}/api/v1/graph/compute_node/@local/fs-records`;

async function dismissSetupModal(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  });
}

test.describe('Full-Text Search', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  // ── Test 1: No params → empty results ─────────────────────────────────────
  test('search with no params returns empty results', async ({ request }) => {
    const res = await request.get(`${CN_FS_BASE}/search`);
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('SUCCESS');
    expect(Array.isArray(body.data.results)).toBe(true);
    expect((body.data.results as unknown[]).length).toBe(0);
    expect(typeof body.data.total).toBe('number');
  });

  // ── Test 2: indexer_ready always present ─────────────────────────────────
  test('search response always has indexer_ready field', async ({ request }) => {
    const r1 = await request.get(`${CN_FS_BASE}/search?q=anything`);
    const b1 = await r1.json();
    expect(typeof b1.data.indexer_ready).toBe('boolean');

    const r2 = await request.get(`${CN_FS_BASE}/search?record_type=skill`);
    const b2 = await r2.json();
    expect(typeof b2.data.indexer_ready).toBe('boolean');
  });

  // ── Test 3: record_type filter returns only that type ────────────────────
  test('search with record_type filter returns only matching type', async ({ request }) => {
    // Index skills first
    await request.post(`${CN_FS_BASE}/index?type=skill`);

    const res = await request.get(`${CN_FS_BASE}/search?record_type=skill`);
    expect(res.status()).toBe(200);

    const body = await res.json();
    const results = body.data.results as Array<{ record_type: string }>;
    if (results.length > 0) {
      for (const r of results) {
        expect(r.record_type).toBe('skill');
      }
    }
  });

  // ── Test 4: result shape matches useRecordSearch expectations ────────────
  test('search result shape has all required fields', async ({ request }) => {
    await request.post(`${CN_FS_BASE}/index?type=skill`);

    const res = await request.get(`${CN_FS_BASE}/search?record_type=skill`);
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.data).toHaveProperty('results');
    expect(body.data).toHaveProperty('total');
    expect(body.data).toHaveProperty('indexer_ready');

    const results = body.data.results as Array<Record<string, unknown>>;
    if (results.length > 0) {
      const r = results[0];
      expect(r).toHaveProperty('record_id');
      expect(r).toHaveProperty('record_type');
      expect(r).toHaveProperty('name');
      expect(r).toHaveProperty('text');
      expect(r).toHaveProperty('status');
      expect(r).toHaveProperty('scope');
      expect(r).toHaveProperty('created_at');
      expect(r).toHaveProperty('modified_at');
      expect(r).toHaveProperty('source_path');
    }
  });

  // ── Test 5: Full cycle — scan → index → search ────────────────────────────
  test('scan → index → search full cycle finds indexed skills', async ({ request }) => {
    // 1. Scan
    const scanRes = await request.get(`${CN_FS_BASE}/scan?type=skill`);
    expect(scanRes.status()).toBe(200);
    const scanBody = await scanRes.json();
    expect(Number(scanBody.data.count)).toBeGreaterThanOrEqual(1);

    // 2. Index
    const indexRes = await request.post(`${CN_FS_BASE}/index?type=skill`);
    expect(indexRes.status()).toBe(200);
    const indexBody = await indexRes.json();
    const totalProcessed = Number(indexBody.data.indexed) + Number(indexBody.data.errors);
    expect(totalProcessed).toBeGreaterThanOrEqual(1);

    // 3. Search — if any were indexed, they should appear
    if (Number(indexBody.data.indexed) > 0) {
      const searchRes = await request.get(`${CN_FS_BASE}/search?record_type=skill`);
      expect(searchRes.status()).toBe(200);
      const searchBody = await searchRes.json();
      const results = searchBody.data.results as Array<{ record_type: string }>;
      expect(results.length).toBeGreaterThanOrEqual(1);
      for (const r of results) {
        expect(r.record_type).toBe('skill');
      }
    }
  });

  // ── Test 6: limit parameter constrains results ────────────────────────────
  test('search limit=1 returns at most 1 result', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/v1/search?q=test&limit=1`);
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('SUCCESS');
    expect((body.data.results as unknown[]).length).toBeLessThanOrEqual(1);
  });

  // ── Test 7: limit=0 does not crash ────────────────────────────────────────
  test('search limit=0 returns non-500 response', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/v1/search?q=test&limit=0`);
    expect(res.status()).not.toBe(500);
  });

  // ── Test 8: limit=-1 does not crash ───────────────────────────────────────
  test('search limit=-1 returns non-500 response', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/v1/search?q=test&limit=-1`);
    expect(res.status()).not.toBe(500);
  });

  // ── Test 9: Search view accessible at /dock/search ────────────────────────
  test('search view is accessible at /dock/search', async ({ page }) => {
    await dismissSetupModal(page);
    await page.goto('/dock/search');
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

    const searchView = page.locator('[data-testid="search-view"]');
    await expect(searchView).toBeVisible({ timeout: 10_000 });
  });

  // ── Test 10: URL ?q= pre-populates input ──────────────────────────────────
  test('URL param ?q=hello pre-populates the search input', async ({ page }) => {
    await dismissSetupModal(page);
    await page.goto('/dock/search?q=hello');
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

    const input = page.locator('[data-testid="search-input"]').first();
    await expect(input).toBeVisible({ timeout: 10_000 });
    await expect(input).toHaveValue('hello', { timeout: 5_000 });
  });

  // ── Test 11: No results empty state ───────────────────────────────────────
  test('search for unmatched query shows empty state message', async ({ page }) => {
    await dismissSetupModal(page);
    await page.goto('/dock/search?q=xyzzy_no_match_9z8w7v');
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

    // Wait for search to settle
    await page.waitForTimeout(2000);

    const results = page.locator('[data-testid="search-results"]');
    await expect(results).toBeVisible({ timeout: 10_000 });

    // Expect empty state or zero results
    const noResults = page.locator('text=/No records found|No results/').first();
    const hasNoResults = await noResults.isVisible().catch(() => false);
    const hasEmptyList = await results.locator('*').count().then((c) => c === 0).catch(() => false);
    expect(hasNoResults || hasEmptyList).toBe(true);
  });

  // ── Test 12: Results area always visible in search view ───────────────────
  test('search results area is always visible in the search view', async ({ page }) => {
    await dismissSetupModal(page);
    await page.goto('/dock/search?q=test');
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

    const results = page.locator('[data-testid="search-results"]');
    await expect(results).toBeVisible({ timeout: 10_000 });
  });
});
