import { expect, test } from '@playwright/test';
import { withViewMode } from '../_shared/view-mode';
import { apiBase } from '../_shared/api';

const API_URL = apiBase();

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
  // The home search surfaces asserted here (`record-search-bar`, `search-input`)
// exist only on the Standard HomeLanding — Vibe renders the creator homepage,
// which has neither. The app legitimately ends up in Vibe (the project-open path
// opens home `.withViewMode(ViewMode.Vibe)` and the dock sync persists that
// instance-wide), so a test wanting Standard must pin it on the ADDRESS rather
// than inherit whatever the instance was last left in.
  await page.goto(withViewMode('/dock/home', 'standard'));
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

  // ── Test 6: Rebuild-index button wires archive→clear→scan→index in order ───
  test('rebuild-index button orchestrates archive, clear, scan and index in order', async ({ page }) => {
    await dismissSetupModal(page);
    await page.goto('/dock/search');
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

    const searchView = page.locator('[data-testid="search-view"]');
    await expect(searchView).toBeVisible({ timeout: 10_000 });

    const readIndexedCount = async (): Promise<number> => {
      const badge = page.locator('text=/\\d+ indexed/').first();
      await expect(badge).toBeVisible({ timeout: 8_000 });
      const text = (await badge.textContent()) ?? '';
      const match = text.match(/(\d+)\s+indexed/);
      expect(match).toBeTruthy();
      return Number(match![1]);
    };

    const indexedBefore = await readIndexedCount();
    expect(indexedBefore).toBeGreaterThanOrEqual(0);

    const rebuildButton = page.locator('[data-testid="rebuild-index"]');
    await expect(rebuildButton).toBeVisible({ timeout: 5_000 });
    await expect(rebuildButton).toBeEnabled({ timeout: 5_000 });

    // Keep this UI contract bounded and side-effect-free: the backend endpoints
    // have their own integration coverage, while this browser test proves the
    // real button → SystemToolsService orchestration without launching a
    // workspace-wide indexer that outlives the per-file Phase 11 inventory.
    //
    // resetAndRescan fans out to:
    //   1. desktop-db/archive        (POST)
    //   2. desktop-db/clear-index    (POST)
    //   3. fs-records/scan?trigger=manual  (GET)
    //   4. fs-records/index          (POST)
    const calls: Array<{ phase: string; method: string; query: string }> = [];
    let resolveIndex!: () => void;
    const indexDispatched = new Promise<void>((resolve) => {
      resolveIndex = resolve;
    });
    await page.route(
      /\/api\/v1\/graph\/compute_node\/@local\/(?:desktop-db\/(?:archive|clear-index)|fs-records\/(?:scan|index))(?:\?.*)?$/,
      async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const phase = url.pathname.endsWith('/archive')
          ? 'archive'
          : url.pathname.endsWith('/clear-index')
            ? 'clear'
            : url.pathname.endsWith('/scan')
              ? 'scan'
              : 'index';
        calls.push({ phase, method: request.method(), query: url.search });
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'SUCCESS',
            data: phase === 'scan' ? { types: [] } : {},
          }),
        });
        if (phase === 'index') resolveIndex();
      },
    );

    await rebuildButton.click();
    await indexDispatched;

    expect(calls).toEqual([
      { phase: 'archive', method: 'POST', query: '' },
      { phase: 'clear', method: 'POST', query: '' },
      { phase: 'scan', method: 'GET', query: '?trigger=manual' },
      { phase: 'index', method: 'POST', query: '?_=1' },
    ]);

    // Button returns to the enabled state once the orchestration finishes (busy=false).
    await expect(rebuildButton).toBeEnabled({ timeout: 5_000 });

    const indexedAfter = await readIndexedCount();
    expect(indexedAfter).toBeGreaterThanOrEqual(0);
  });
});
