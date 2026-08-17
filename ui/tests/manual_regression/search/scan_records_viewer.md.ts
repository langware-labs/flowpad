import { expect, test } from '@playwright/test';
import { apiBase } from '../_shared/api';

const API_URL = apiBase();
const CN_FS_BASE = `${API_URL}/api/v1/graph/compute_node/@local/fs-records`;
const LENS_PATH = '/dock/lens/fs-records/scan/';

async function dismissSetupModal(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  });
}

// The read-only rescan action is the "Scan Stats" button (GET /fs-records/scan)
// in the action row (Sync changes, Force re-sync, Rebuild index, Scan Stats,
// Scan Orphans, LLM Indexers, Clear Index).
function headerRescanButton(page: import('@playwright/test').Page) {
  return page.getByRole('button', { name: 'Scan Stats', exact: true }).first();
}

test.describe('FsRecordsScannerViewer (/dock/lens/fs-records/scan)', () => {
  // ── Test 1: Lens renders with expected header + action buttons ──────────────
  test('FsRecordsScannerViewer is reachable via /dock/lens/fs-records/scan', async ({ page }) => {
    await dismissSetupModal(page);
    await page.goto(LENS_PATH);
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

    await expect(page.getByRole('heading', { name: 'Records Scanner' })).toBeVisible({ timeout: 10_000 });
    // Primary index action (POST /fs-records/index) is the "Fast" button
    // ("Indexing…" while in flight); "Full" (force=true) sits next to it.
    await expect(page.getByRole('button', { name: /Fast|Indexing/ })).toBeVisible({ timeout: 10_000 });
    await expect(headerRescanButton(page)).toBeVisible({ timeout: 10_000 });
  });

  // ── Test 2: Backend aggregate scan API returns expected shape ───────────────
  test('Backend aggregate scan API returns the expected response shape', async ({ request }) => {
    const res = await request.get(`${CN_FS_BASE}/scan?limit_types=5`);
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('SUCCESS');
    expect(Array.isArray(body.data.types)).toBe(true);
    expect(typeof body.data.grand_total).toBe('number');
    expect(typeof body.data.scan_ms).toBe('number');
  });

  // ── Test 3: Registered-types endpoint returns list including "skill" ────────
  test('Backend registered-types endpoint returns a non-empty list including "skill"', async ({ request }) => {
    const res = await request.get(`${CN_FS_BASE}`);
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('SUCCESS');
    expect(Array.isArray(body.data.types)).toBe(true);
    expect((body.data.types as string[]).length).toBeGreaterThan(0);
    expect(body.data.types as string[]).toContain('skill');
  });
});
