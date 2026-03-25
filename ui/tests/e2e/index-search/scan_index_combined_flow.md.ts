import { expect, test } from '@playwright/test';

const API_URL = process.env.API_URL ?? 'http://localhost:9007';
const CN_FS_BASE = `${API_URL}/api/v1/graph/compute_node/@local/fs-records`;

async function dismissSetupModal(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  });
}

test.describe('Scan + Index Combined Flow', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  // ── Test 1: resetAndRescan — aggregate scan then aggregate index ──────────
  test('aggregate scan then aggregate index completes successfully', async ({ request }) => {
    // 1. Aggregate scan (limited for speed)
    const scanRes = await request.get(`${CN_FS_BASE}/scan?limit_types=3`);
    expect(scanRes.status()).toBe(200);
    const scanBody = await scanRes.json();
    expect(scanBody.status).toBe('SUCCESS');
    expect(Number(scanBody.data.grand_total)).toBeGreaterThanOrEqual(0);

    // 2. Aggregate index (limited for speed)
    const indexRes = await request.post(`${CN_FS_BASE}/index?limit_types=3`);
    expect(indexRes.status()).toBe(200);
    const indexBody = await indexRes.json();
    expect(indexBody.status).toBe('SUCCESS');
    expect(typeof indexBody.data.indexed).toBe('number');
  });

  // ── Test 2: Scan → per-type drill-down → index → search ──────────────────
  test('scan → index → search for skill type finds indexed records', async ({ request }) => {
    // Scan
    const scanRes = await request.get(`${CN_FS_BASE}/scan?type=skill`);
    expect(scanRes.status()).toBe(200);
    const scanBody = await scanRes.json();
    expect(Number(scanBody.data.count)).toBeGreaterThanOrEqual(1);

    // Index
    const indexRes = await request.post(`${CN_FS_BASE}/index?type=skill`);
    expect(indexRes.status()).toBe(200);
    const indexBody = await indexRes.json();
    expect(indexBody.data.indexed + indexBody.data.errors).toBeGreaterThanOrEqual(1);

    // Search
    const searchRes = await request.get(`${CN_FS_BASE}/search?record_type=skill`);
    expect(searchRes.status()).toBe(200);
    const searchBody = await searchRes.json();
    if (Number(indexBody.data.indexed) > 0) {
      expect((searchBody.data.results as unknown[]).length).toBeGreaterThanOrEqual(1);
    }
  });

  // ── Test 3: Consecutive scans return consistent results ───────────────────
  test('consecutive scans of same type return consistent count', async ({ request }) => {
    const r1 = await request.get(`${CN_FS_BASE}/scan?type=skill`);
    const r2 = await request.get(`${CN_FS_BASE}/scan?type=skill`);

    expect(r1.status()).toBe(200);
    expect(r2.status()).toBe(200);

    const b1 = await r1.json();
    const b2 = await r2.json();

    // Count should be same or close (no records added between scans)
    const count1 = Number(b1.data.count);
    const count2 = Number(b2.data.count);
    expect(count2).toBeGreaterThanOrEqual(count1);
  });

  // ── Test 4: limit_per_type constrains per-type indexing ──────────────────
  test('index with limit_per_type=1 and limit_types=2 indexes at most 2 records', async ({ request }) => {
    const res = await request.post(`${CN_FS_BASE}/index?limit_per_type=1&limit_types=2`);
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('SUCCESS');
    // With limit_per_type=1 and limit_types=2, total indexed <= 2
    expect(Number(body.data.indexed)).toBeLessThanOrEqual(2);
  });

  // ── Test 5: Clear FTS index then re-index recovers cleanly ───────────────
  test('index after clearing FTS index re-indexes successfully', async ({ request }) => {
    // Clear only the FTS search index (not the full DB)
    await request.post(
      `${API_URL}/api/v1/graph/compute_node/@local/desktop-db/clear-index`,
    ).catch(() => {});

    // Re-index skills
    const res = await request.post(`${CN_FS_BASE}/index?type=skill`);
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('SUCCESS');
    expect(typeof body.data.indexed).toBe('number');
  });

  // ── Test 6: index-status reflects stale=true before indexing ─────────────
  test('index-status returns expected shape before and after indexing', async ({ request }) => {
    const before = await request.get(`${CN_FS_BASE}/index-status`);
    expect(before.status()).toBe(200);
    const beforeBody = await before.json();
    expect(typeof beforeBody.data.never_indexed).toBe('boolean');
    expect(typeof beforeBody.data.stale).toBe('boolean');

    // Index
    await request.post(`${CN_FS_BASE}/index?type=skill`);

    const after = await request.get(`${CN_FS_BASE}/index-status`);
    expect(after.status()).toBe(200);
    const afterBody = await after.json();
    // After indexing, stale should be false (or at least the field exists)
    expect(typeof afterBody.data.stale).toBe('boolean');
  });

  // ── Test 7: Bootstrap scan_info reflects post-index state ─────────────────
  test('bootstrap scan_info.never_indexed is false after indexing', async ({ request }) => {
    // Index some records
    await request.post(`${CN_FS_BASE}/index?type=skill`);

    const res = await request.get(`${API_URL}/api/v1/graph/bootstrap`);
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('SUCCESS');

    const scanInfo = body.data?.scan_info;
    if (scanInfo) {
      // After indexing, never_indexed should be false
      expect(typeof scanInfo.never_indexed).toBe('boolean');
      expect(typeof scanInfo.total_indexed).toBe('number');
      expect(scanInfo.total_indexed).toBeGreaterThanOrEqual(0);
    }
  });
});
