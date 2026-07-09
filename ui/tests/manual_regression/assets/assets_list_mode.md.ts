import { expect, test, type Page } from '@playwright/test';
import { apiBase } from '../_shared/api';
import { ensureAgentAndSkill } from './_seed';

const API = apiBase();

async function dismissSetupModal(page: Page) {
  await page.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));
}
async function dismissWelcomeModalIfShown(page: Page) {
  for (const name of ['Skip for now', 'Not Now', 'Not now']) {
    const btn = page.getByRole('button', { name });
    if (await btn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await btn.click();
      return;
    }
  }
}

// Assets page = collapsible BrowseableTree (asset-type roots) + AssetListView.
// The older LayoutList/Network mode toggle + type pills never shipped.
test.describe('Assets Page — BrowseableTree + AssetListView', () => {
  // After a desktop-db/clear the workspace is "never indexed": the asset tree has
  // no populated roots and the right panel shows the index-prompt CTA instead of
  // the "Select a type to browse" placeholder. Indexing is an explicit user
  // action (never automatic), so the test seeds + indexes one agent and one skill
  // — exactly what a user would do — before asserting the populated-tree UI.
  test.beforeEach(async ({ page }) => {
    await ensureAgentAndSkill(page);
  });

  test('1: /dock/assets renders the tree sidebar + placeholder right panel', async ({ page }) => {
    await dismissSetupModal(page);
    await page.goto('/dock/assets');
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    await dismissWelcomeModalIfShown(page);

    await expect(page.getByRole('tree'), 'asset-type sidebar tree visible').toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('treeitem', { level: 1 }).first(), 'at least one level-1 treeitem').toBeVisible();
    await expect(page.getByText('Select a type to browse', { exact: false })).toBeVisible();
  });

  test('2: header renders assets controls (no LayoutList/Network toggles)', async ({ page }) => {
    await dismissSetupModal(page);
    await page.goto('/dock/assets');
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    await dismissWelcomeModalIfShown(page);

    await expect(page.getByText('Assets', { exact: false }).first()).toBeVisible();
    // No phantom mode toggles.
    const toggles = page.locator(
      '[aria-label*="hierarchy"], [aria-label*="list mode"], button:has(svg.lucide-layout-list), button:has(svg.lucide-network)',
    );
    expect(await toggles.count(), 'no LayoutList/Network mode toggles exist').toBe(0);
    // The refresh / rebuild-index control is present.
    const rebuild = page.locator('[data-testid="rebuild-index"], button[title="Refresh search data"]');
    expect(await rebuild.count(), 'rebuild-index / refresh control present').toBeGreaterThanOrEqual(1);
  });

  test('3: /dock/assets/list/skill renders an AssetListView (not the placeholder)', async ({ page }) => {
    await dismissSetupModal(page);
    await page.goto('/dock/assets/list/skill');
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    await dismissWelcomeModalIfShown(page);

    await expect(page.getByText('Select a type to browse', { exact: false })).toHaveCount(0);
    // A search/tag input is rendered above the list.
    await expect(page.locator('input[type="text"], input:not([type])').first()).toBeVisible({ timeout: 15_000 });
    // Either a table or an empty-state message.
    const table = page.locator('table');
    const empty = page.getByText(/No results|No skills|empty/i);
    const ok = (await table.count()) > 0 || (await empty.count()) > 0;
    expect(ok, 'AssetListView shows a table or an empty-state').toBe(true);
  });

  test('4: sidebar treeitems include the core asset types', async ({ page }) => {
    await dismissSetupModal(page);
    await page.goto('/dock/assets');
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    await dismissWelcomeModalIfShown(page);

    await expect(page.getByRole('tree')).toBeVisible({ timeout: 15_000 });
    // The asset tree renders a curated root set (agent/skill/markdown/spec);
    // assert the stable creatable core. (Workflow is no longer an asset-tree root.)
    for (const name of ['Agent', 'Skill', 'Markdown']) {
      await expect(
        page.getByRole('treeitem', { name: new RegExp(name, 'i') }).first(),
        `treeitem ${name} present`,
      ).toBeVisible();
    }
  });

  test('5: expand a populated type via its chevron prefix-match selector', async ({ page }) => {
    await dismissSetupModal(page);
    await page.goto('/dock/assets');
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    await dismissWelcomeModalIfShown(page);
    await expect(page.getByRole('tree')).toBeVisible({ timeout: 15_000 });

    // Pick a level-1 root that has a non-zero count badge (an empty type — e.g.
    // skill at 0 — has no children to expand). The accessible NAME embeds the
    // count, e.g. "Expand Plan 221 Scan for changes" → match a name with a digit.
    const root = page.getByRole('treeitem', { level: 1, name: /\d/ }).first();
    await expect(root, 'a populated asset-type root exists').toBeVisible({ timeout: 15_000 });
    // Expand via the row's chevron (prefix-match testid lives inside the row).
    const chevron = root.locator('[data-testid^="browseable-chevron-asset-type:"]').first();
    await expect(chevron).toBeVisible();
    await chevron.click();
    // A level-2 treeitem appears under the expanded root (children load async).
    await expect(page.getByRole('treeitem', { level: 2 }).first()).toBeVisible({ timeout: 5_000 });
  });

  test('6: API smoke — /api/v1/assets/types returns the core set', async ({ request }) => {
    const res = await request.get(`${API}/api/v1/assets/types`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('SUCCESS');
    const names: string[] = (body.data.types as Array<{ type_name: string }>).map((t) => t.type_name);
    for (const core of ['agent', 'skill', 'workflow', 'markdown']) {
      expect(names, `types includes ${core}`).toContain(core);
    }
  });
});
