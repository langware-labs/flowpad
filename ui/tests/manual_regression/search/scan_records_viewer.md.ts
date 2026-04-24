import { expect, test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

function resolveApiUrl(): string {
  if (process.env.API_URL) return process.env.API_URL;
  const candidates: string[] = [];
  try { candidates.push(path.resolve(path.dirname(fileURLToPath(new URL(import.meta.url))), '../../../.env.local')); } catch (_) {}
  try { candidates.push(path.resolve(process.cwd(), '.env.local')); } catch (_) {}
  for (const envPath of candidates) {
    try {
      if (fs.existsSync(envPath)) {
        for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
          const eq = line.indexOf('=');
          if (eq < 1) continue;
          if (line.slice(0, eq).trim() === 'LOCAL_SERVER_PORT') {
            return `http://localhost:${line.slice(eq + 1).trim()}`;
          }
        }
      }
    } catch (_) { /* ignore */ }
  }
  return 'http://localhost:9008';
}

const API_URL = resolveApiUrl();
const CN_FS_BASE = `${API_URL}/api/v1/graph/compute_node/@local/fs-records`;
const LENS_PATH = '/dock/lens/fs-records/scan/';

async function dismissSetupModal(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  });
}

// The header Rescan button is the last one in the action row (Index All, Rescan, Clear Index).
// The empty-state banner also has a Rescan link, so we scope to header buttons via a role+name
// locator and then pick the first enabled one.
function headerRescanButton(page: import('@playwright/test').Page) {
  return page.getByRole('button', { name: 'Rescan', exact: true }).first();
}

async function triggerInitialScan(page: import('@playwright/test').Page) {
  // There may be two Rescan buttons on the page: the header button and an empty-state link.
  // Either one triggers a scan — click whichever is visible first.
  const rescan = page.getByRole('button', { name: 'Rescan', exact: true }).first();
  await expect(rescan).toBeVisible({ timeout: 10_000 });
  await rescan.click();
}

test.describe('FsRecordsScannerViewer (/dock/lens/fs-records/scan)', () => {
  // ── Test 1: Lens renders with expected header + action buttons ──────────────
  test('FsRecordsScannerViewer is reachable via /dock/lens/fs-records/scan', async ({ page }) => {
    await dismissSetupModal(page);
    await page.goto(LENS_PATH);
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

    await expect(page.getByRole('heading', { name: 'Records Scanner' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: /Index All|Indexing/ })).toBeVisible({ timeout: 10_000 });
    await expect(headerRescanButton(page)).toBeVisible({ timeout: 10_000 });
  });

  // ── Test 2: Per-type stats table renders after running a scan ───────────────
  test('Per-type rows render with count/size/status columns after initial scan', async ({ page }) => {
    await dismissSetupModal(page);
    await page.goto(LENS_PATH);
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    await triggerInitialScan(page);

    const table = page.locator('table').first();
    await expect(table).toBeVisible({ timeout: 60_000 });

    const header = table.locator('thead');
    await expect(header).toContainText('Type');
    await expect(header).toContainText('Count');
    await expect(header).toContainText('Size');
    await expect(header).toContainText('Status');

    const rows = table.locator('tbody tr');
    await expect(rows.first()).toBeVisible({ timeout: 10_000 });
    expect(await rows.count()).toBeGreaterThan(0);
  });

  // ── Test 3: Rescan triggers a fresh scan and totals remain visible ──────────
  test('Clicking "Rescan" triggers a fresh scan and refreshes totals', async ({ page }) => {
    await dismissSetupModal(page);
    await page.goto(LENS_PATH);
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    await triggerInitialScan(page);

    const totals = page.locator('text=/\\d+[\\d,]*\\s+records/').first();
    await expect(totals).toBeVisible({ timeout: 60_000 });

    // Trigger an explicit second scan via the header button
    const rescanBtn = headerRescanButton(page);
    await expect(rescanBtn).toBeEnabled({ timeout: 10_000 });
    await rescanBtn.click();

    // After the second scan settles, totals should still be visible
    await page.waitForTimeout(1000);
    await expect(page.locator('text=/\\d+[\\d,]*\\s+records/').first()).toBeVisible({ timeout: 60_000 });
  });

  // ── Test 4: "Index All" kicks off per-type indexing and settles ─────────────
  test('Clicking "Index All" runs per-type indexing via POST /fs-records/index', async ({ page }) => {
    await dismissSetupModal(page);
    await page.goto(LENS_PATH);
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    await triggerInitialScan(page);

    // Wait for the stats table — Index All is disabled until scan results are available.
    await expect(page.locator('table').first()).toBeVisible({ timeout: 60_000 });

    const indexAllBtn = page.getByRole('button', { name: /Index All|Indexing/ });
    await expect(indexAllBtn).toBeEnabled({ timeout: 15_000 });
    await indexAllBtn.click();

    // Wait for indexing to finish: button returns to "Index All" and becomes enabled again.
    await expect(page.getByRole('button', { name: 'Index All' })).toBeEnabled({ timeout: 180_000 });
  });

  // ── Test 5: Backend aggregate scan API returns expected shape ───────────────
  test('Backend aggregate scan API returns the expected response shape', async ({ request }) => {
    const res = await request.get(`${CN_FS_BASE}/scan?limit_types=5`);
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('SUCCESS');
    expect(Array.isArray(body.data.types)).toBe(true);
    expect(typeof body.data.grand_total).toBe('number');
    expect(typeof body.data.scan_ms).toBe('number');
  });

  // ── Test 6: Registered-types endpoint returns list including "skill" ────────
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
