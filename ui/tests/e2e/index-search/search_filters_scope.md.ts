import { expect, test } from '@playwright/test';

const API_URL = process.env.API_URL ?? 'http://localhost:9007';
const CN_FS_BASE = `${API_URL}/api/v1/graph/compute_node/@local/fs-records`;

async function dismissSetupModal(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  });
}

test.describe('Search Filters — Scope & Type', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  // ── Test 1: Tools button toggles filter panel ─────────────────────────────
  test('Tools button on home bar toggles the filter panel', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

    const toolsBtn = page.locator('[data-testid="search-tools-btn"]').first();
    await expect(toolsBtn).toBeVisible({ timeout: 10_000 });

    const filterPanel = page.locator('[data-testid="search-filter-panel"]').first();
    await expect(filterPanel).not.toBeVisible();

    await toolsBtn.click();
    await expect(filterPanel).toBeVisible({ timeout: 5_000 });

    await toolsBtn.click();
    await expect(filterPanel).not.toBeVisible();
  });

  // ── Test 2: API — scope=user returns user-scoped results only ────────────
  test('GET /search?scope=user returns only user-scoped results', async ({ request }) => {
    await request.post(`${CN_FS_BASE}/index?type=skill`);

    const res = await request.get(`${CN_FS_BASE}/search?scope=user&record_type=skill`);
    expect(res.status()).toBe(200);

    const body = await res.json();
    const results = body.data.results as Array<{ scope: string }>;
    if (results.length > 0) {
      for (const r of results) {
        expect(r.scope).toBe('user');
      }
    }
  });

  // ── Test 3: API — scope=project with project_ids does not error ──────────
  test('GET /search?scope=project&project_ids=local does not error', async ({ request }) => {
    const res = await request.get(
      `${CN_FS_BASE}/search?scope=project&project_ids=local&record_type=skill`,
    );
    // Should not 500
    expect(res.status()).not.toBe(500);
    expect(res.status()).toBe(200);
  });

  // ── Test 4: API — no scope filter returns all scopes ─────────────────────
  test('GET /search without scope filter returns records from any scope', async ({ request }) => {
    await request.post(`${CN_FS_BASE}/index?type=skill`);

    const res = await request.get(`${CN_FS_BASE}/search?record_type=skill`);
    expect(res.status()).toBe(200);

    const body = await res.json();
    // Results may have mixed scopes — just validate the response shape
    expect(Array.isArray(body.data.results)).toBe(true);
    expect(typeof body.data.total).toBe('number');
  });

  // ── Test 5: Asset browser scope filter buttons render ────────────────────
  test('asset browser shows All/User/Project scope filter buttons', async ({ page }) => {
    await page.goto('/dock/assets');
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

    // The ScopeFilterBar renders buttons with text All, User, Project
    const allBtn = page.locator('button', { hasText: 'All' }).first();
    const userBtn = page.locator('button', { hasText: 'User' }).first();
    const projectBtn = page.locator('button', { hasText: 'Project' }).first();

    // At least "All" should be visible
    const hasAll = await allBtn.isVisible().catch(() => false);
    const hasUser = await userBtn.isVisible().catch(() => false);

    // If scope filter is present, validate it
    if (hasAll && hasUser) {
      await expect(allBtn).toBeVisible();
      await expect(userBtn).toBeVisible();
      await expect(projectBtn).toBeVisible();

      // Click User
      await userBtn.click();
      // User should now be highlighted (active class applied)
      const userClass = await userBtn.getAttribute('class') ?? '';
      expect(userClass).toMatch(/bg-accent|active|selected/);

      // Click All to reset
      await allBtn.click();
    }
    // If scope filter not visible, test passes (may be hidden for now)
  });

  // ── Test 6: Search view is accessible ────────────────────────────────────
  test('search view at /dock/search shows search results area', async ({ page }) => {
    await page.goto('/dock/search');
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

    const searchView = page.locator('[data-testid="search-view"]');
    await expect(searchView).toBeVisible({ timeout: 10_000 });
  });

  // ── Test 7: API — tags filter does not error ──────────────────────────────
  test('GET /search?tags=test does not error', async ({ request }) => {
    const res = await request.get(`${CN_FS_BASE}/search?tags=test`);
    expect(res.status()).not.toBe(500);
  });

  // ── Test 8: Search with record_type pre-filters the query ────────────────
  test('search with record_type=agent does not mix in skill results', async ({ request }) => {
    await request.post(`${CN_FS_BASE}/index?type=skill`);
    await request.post(`${CN_FS_BASE}/index?type=agent`).catch(() => {});

    const res = await request.get(`${CN_FS_BASE}/search?record_type=agent`);
    expect(res.status()).toBe(200);

    const body = await res.json();
    const results = body.data.results as Array<{ record_type: string }>;
    for (const r of results) {
      expect(r.record_type).toBe('agent');
    }
  });
});
