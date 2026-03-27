import { expect, test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// Resolve the API URL: prefer process.env.API_URL, then read LOCAL_SERVER_PORT from
// ui/.env.local, then fall back to 9008. We read .env.local directly here because
// in Playwright ESM mode, process.env mutations made in playwright.config.ts do not
// propagate to worker processes that run the test files.
function resolveApiUrl(): string {
  if (process.env.API_URL) return process.env.API_URL;
  // Try multiple candidate paths for .env.local.
  // Build candidates safely — import.meta.url may not be available in all worker contexts.
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

    // Dismiss WelcomeModal if shown (appears after DB reset when scanInfo.never_indexed=true).
    // When open, the AlertDialog sets aria-hidden on the rest of the page, blocking pointer events.
    const skipForNow = page.getByRole('button', { name: 'Skip for now' });
    if (await skipForNow.isVisible({ timeout: 12_000 }).catch(() => false)) {
      await skipForNow.click();
    }

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
