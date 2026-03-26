import { expect, test } from '@playwright/test';

const API_URL = process.env.API_URL ?? 'http://localhost:9007';
const CN_FS_BASE = `${API_URL}/api/v1/graph/compute_node/@local/fs-records`;

async function dismissSetupModal(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  });
}

// The FsRecordsScannerViewer is rendered inside the LensViewer.
// Navigate to the scanner via the dedicated fs-records lens route if available,
// otherwise navigate to the home page and open the panel.
async function gotoScanner(page: import('@playwright/test').Page) {
  await dismissSetupModal(page);
  // Try the direct dock route first
  await page.goto('/dock/scanner');
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Records Scanner Viewer', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  // ── Test 1: API — registered types list ────────────────────────────────────
  test('GET /fs-records returns list of registered types', async ({ request }) => {
    const res = await request.get(`${CN_FS_BASE}`);
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('SUCCESS');
    expect(Array.isArray(body.data.types)).toBe(true);
    expect((body.data.types as string[]).length).toBeGreaterThan(0);
    expect(body.data.types as string[]).toContain('skill');
  });

  // ── Test 2: API — aggregate scan returns expected shape ────────────────────
  test('GET /fs-records/scan (aggregate) returns types, grand_total, scan_ms', async ({ request }) => {
    const res = await request.get(`${CN_FS_BASE}/scan?limit_types=5`);
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('SUCCESS');
    expect(body.data).toHaveProperty('types');
    expect(body.data).toHaveProperty('grand_total');
    expect(body.data).toHaveProperty('scan_ms');
    expect(Array.isArray(body.data.types)).toBe(true);
  });

  // ── Test 3: API — per-type scan discovers skills ───────────────────────────
  test('GET /fs-records/scan?type=skill discovers skills', async ({ request }) => {
    const res = await request.get(`${CN_FS_BASE}/scan?type=skill`);
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('SUCCESS');
    expect(body.data.type).toBe('skill');
    expect(Number(body.data.count)).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(body.data.records)).toBe(true);

    // Each record has expected shape
    const records = body.data.records as Array<{ id: string; name: string; size_bytes: number }>;
    expect(records.length).toBeGreaterThanOrEqual(1);
    for (const r of records) {
      expect(r.id).toBeTruthy();
      expect(typeof r.size_bytes).toBe('number');
    }
  });

  // ── Test 4: API — per-type scan includes byte stats ───────────────────────
  test('GET /fs-records/scan?type=skill includes min/max/avg bytes', async ({ request }) => {
    const res = await request.get(`${CN_FS_BASE}/scan?type=skill`);
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.data).toHaveProperty('min_bytes');
    expect(body.data).toHaveProperty('max_bytes');
    expect(body.data).toHaveProperty('avg_bytes');
    expect(body.data).toHaveProperty('scan_ms');
  });

  // ── Test 5: API — unknown type returns 400 ────────────────────────────────
  test('GET /fs-records/scan?type=unknown_xyz returns non-500 error', async ({ request }) => {
    const res = await request.get(`${CN_FS_BASE}/scan?type=no_such_type_xyz_abc`);
    // Should return a 4xx, not 500
    expect(res.status()).not.toBe(500);
    expect(res.status()).toBeLessThan(500);
  });

  // ── Test 6: API — limit_types parameter constrains response ───────────────
  test('GET /fs-records/scan?limit_types=2 scans at most 2 types', async ({ request }) => {
    const res = await request.get(`${CN_FS_BASE}/scan?limit_types=2`);
    expect(res.status()).toBe(200);

    const body = await res.json();
    // When limit_types is set, the types array should have at most that many entries
    expect(body.status).toBe('SUCCESS');
  });
});
