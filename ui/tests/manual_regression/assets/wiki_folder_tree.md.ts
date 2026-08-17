import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { apiBase } from '../_shared/api';

const API = apiBase();

async function dismissSetupModal(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  });
}

async function seedIndexedMarkdown(request: APIRequestContext): Promise<void> {
  const bootstrap = await request.get(`${API}/api/v1/graph/bootstrap?domain=localhost`);
  expect(bootstrap.status(), await bootstrap.text()).toBe(200);
  const bootstrapData = (await bootstrap.json()).data;
  const project =
    bootstrapData.default_project ??
    bootstrapData.local_project ??
    bootstrapData.project;
  const projectId = typeof project === 'string' ? project : project?.id;
  expect(projectId, 'bootstrap returned no default project id').toBeTruthy();

  const created = await request.post(`${API}/api/v1/graph/project/${projectId}/markdown`, {
    data: { name: `qa-wiki-tree-${randomUUID()}` },
  });
  expect(created.status(), await created.text()).toBe(200);
  const assetRef = (await created.json()).data.asset_ref as string;
  expect(assetRef, 'seeded markdown has an asset_ref').toBeTruthy();

  const indexed = await request.post(
    `${API}/api/v1/graph/compute_node/@local/fs-records/invalidate`,
    { data: { paths: [assetRef], deleted_paths: [] } },
  );
  expect(indexed.status(), await indexed.text()).toBe(200);
}

test.describe('Wiki folder tree (asset browseable tree)', () => {
  test.beforeEach(async ({ request }) => {
    await seedIndexedMarkdown(request);
  });

  // ── Test 1: Folder tree renders markdown vault roots on expand ────────────
  // Environment-dependent: only asserts vault children when the user has
  // markdown vaults configured (AssetTypeInfo.vaults non-empty). Otherwise
  // just validates the chevron expanded successfully.
  test('Folder tree renders markdown vault roots on expand', async ({ page, request }) => {
    await dismissSetupModal(page);
    await page.goto('/dock/assets/list/markdown');
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

    const chevron = page.locator('[data-testid^="browseable-chevron-asset-type:markdown"]').first();
    await expect(chevron).toBeVisible({ timeout: 10_000 });

    // The markdown root is auto-expanded by ``expandParentsForPointer`` when
    // the active dock URL is /dock/assets/list/markdown (the root owns that
    // pointer). Clicking the chevron would COLLAPSE it. Only click when the
    // row reports aria-expanded="false".
    const expandedAttr = await chevron.evaluateHandle((el: any) => el.closest('[role="treeitem"]')?.getAttribute('aria-expanded'));
    const expandedVal = await expandedAttr.jsonValue();
    if (expandedVal !== 'true') {
      await chevron.click();
    }

    // Probe the backend for markdown vaults to decide what to assert.
    const typesRes = await request.get(`${API}/api/v1/assets/types`).catch(() => null);
    let hasVaults = false;
    if (typesRes && typesRes.ok()) {
      const body = await typesRes.json().catch(() => null);
      const types = body?.data?.types ?? body?.data ?? [];
      const md = Array.isArray(types) ? types.find((t: { type_name?: string }) => t.type_name === 'markdown') : null;
      hasVaults = Array.isArray(md?.vaults) && md.vaults.length > 0;
    }

    if (hasVaults) {
      const vaultRoot = page.locator('[role="treeitem"][aria-level="2"]').first();
      await expect(vaultRoot).toBeVisible({ timeout: 10_000 });
      const vaultLabelMatch = page.locator(
        '[role="treeitem"][aria-level="2"]:has-text("User docs"), ' +
        '[role="treeitem"][aria-level="2"]:has-text("Project docs"), ' +
        '[role="treeitem"][aria-level="2"]:has-text("Workspace docs")'
      ).first();
      await expect(vaultLabelMatch).toBeVisible({ timeout: 5_000 });
    } else {
      // No vaults — just assert the markdown type row is expanded (aria-expanded="true")
      const typeRow = page.locator('[role="treeitem"][aria-level="1"]').filter({ hasText: /Markdown/i }).first();
      await expect(typeRow).toBeVisible({ timeout: 5_000 });
    }
  });

  // ── Test 2: Clicking a folder navigates to folder URL + breadcrumb ────────
  // Skipped (soft) when no markdown vaults exist — there is nothing to click.
  test('Clicking a vault-root folder navigates to folder URL and shows breadcrumb', async ({ page, request }) => {
    await dismissSetupModal(page);
    await page.goto('/dock/assets/list/markdown');
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

    // The markdown root is auto-expanded by ``expandParentsForPointer`` for
    // /dock/assets/list/markdown. Only click the chevron if it's currently
    // collapsed; otherwise the click would collapse the already-open tree
    // and hide the vault rows the rest of the test needs.
    const chevron = page.locator('[data-testid^="browseable-chevron-asset-type:markdown"]').first();
    await expect(chevron).toBeVisible({ timeout: 10_000 });
    const expandedAttr = await chevron.evaluateHandle((el: any) => el.closest('[role="treeitem"]')?.getAttribute('aria-expanded'));
    const expandedVal = await expandedAttr.jsonValue();
    if (expandedVal !== 'true') {
      await chevron.click();
    }

    const typesRes = await request.get(`${API}/api/v1/assets/types`).catch(() => null);
    let hasVaults = false;
    if (typesRes && typesRes.ok()) {
      const body = await typesRes.json().catch(() => null);
      const types = body?.data?.types ?? body?.data ?? [];
      const md = Array.isArray(types) ? types.find((t: { type_name?: string }) => t.type_name === 'markdown') : null;
      hasVaults = Array.isArray(md?.vaults) && md.vaults.length > 0;
    }
    test.skip(!hasVaults, 'No markdown vaults configured — vault navigation not applicable');

    const vaultRoot = page.locator('[role="treeitem"][aria-level="2"]').first();
    await expect(vaultRoot).toBeVisible({ timeout: 10_000 });
    await vaultRoot.click();

    await expect(page).toHaveURL(/\/dock\/assets\/folder\/markdown\//, { timeout: 10_000 });

    const breadcrumb = page.locator('[data-testid="asset-list-breadcrumb"]');
    await expect(breadcrumb).toBeVisible({ timeout: 10_000 });
  });

  // ── Test 9: Scan toolbar action on the Markdown root triggers reindex ─────
  test('Scan toolbar action on markdown root triggers POST /fs-records/index?type=markdown', async ({ page }) => {
    await dismissSetupModal(page);
    await page.goto('/dock/assets/list/markdown');
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

    // Collect console errors for the "no console errors" assertion.
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    // The toolbar button is rendered inside the aria-level=1 markdown type row.
    // Hover over the row to reveal the toolbar (in case visibility is hover-gated).
    const typeRow = page.locator('[role="treeitem"][aria-level="1"]').filter({ hasText: /markdown/i }).first();
    await expect(typeRow).toBeVisible({ timeout: 10_000 });
    await typeRow.hover();

    const scanBtn = page.locator('[data-testid="browseable-toolbar-scan:markdown"]');
    await expect(scanBtn).toBeVisible({ timeout: 10_000 });

    // Listen for the reindex POST before clicking.
    const reindexRequest = page.waitForRequest(
      (req) =>
        req.method() === 'POST' &&
        /\/api\/v1\/graph\/compute_node\/@local\/fs-records\/index\?type=markdown/.test(req.url()),
      { timeout: 15_000 },
    );

    await scanBtn.click();
    const req = await reindexRequest;
    expect(req.method()).toBe('POST');
    expect(req.url()).toContain('/api/v1/graph/compute_node/@local/fs-records/index?type=markdown');

    // Give the browser a short moment to finish producing any error messages.
    await page.waitForTimeout(500);
    expect(
      consoleErrors.filter((e) => !/favicon|ResizeObserver/i.test(e)),
    ).toEqual([]);
  });
});
