/**
 * Project view = asset browser (record-removal UX).
 * Source: project_row_opens_collab_space.md
 *
 * `project` is NOT in EDITOR_TYPES (ts_sdk asset-editor.ts), so
 * hasEditor('project') is false and AssetsPage leaves project list rows
 * without onRowClick (no cursor-pointer, not a click target). Project
 * navigation flows through navigateToResult's `project` case from the
 * BrowseableTree / search, and /dock/project/<uuid> directly renders the asset
 * browser. Tests assert that actual surface.
 */
import { test, expect } from '@playwright/test';
import { apiBase, apiContext } from '../_shared/api';

const API = apiBase();

async function firstProjectId(): Promise<string> {
  const rq = await apiContext();
  const d = (await (await rq.get(`${API}/api/v1/graph/project`)).json()).data;
  await rq.dispose();
  const id = Array.isArray(d) ? d[0]?.id : d?.id;
  expect(id, 'a project id from GET /api/v1/graph/project').toBeTruthy();
  return id;
}

test.describe('Project view = asset browser', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('llm-setup-modal-seen', 'true');
    });
  });

  test('test 1: Direct navigation to /dock/project/<uuid> renders the project asset browser', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    const pid = await firstProjectId();
    await page.goto(`/dock/project/${pid}`);
    await page.waitForLoadState('networkidle', { timeout: 25_000 }).catch(() => {});
    expect(page.url()).toMatch(/\/dock\/project\/[0-9a-f-]{36}/);
    await expect(page.locator('body')).not.toContainText('No editor for type: project');
    // Project view header renders "Project assets"; the project scope indicator
    // is the project-name chip (data-testid="project-name-chip"), not a "Project:" label.
    await expect(page.getByText('Project assets').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('project-name-chip').first()).toBeVisible({ timeout: 15_000 });

    const offending = errors.filter((e) => !/ResizeObserver|favicon/.test(e) && !/user-/.test(e) && !/agent_hook/.test(e) && !/\b404\b/.test(e));
    expect(offending, `Console errors: ${offending.join(', ')}`).toHaveLength(0);
  });

  test('test 2: The asset browser exposes a project-scope filter chip (no Project tree node)', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('/dock/assets');
    await page.waitForLoadState('networkidle', { timeout: 25_000 }).catch(() => {});

    // The BrowseableTree groups by editable type; project has no asset editor,
    // so the project surface here is the project-scope filter control. That
    // control is the ScopeFilterIconBar "Project" toggle, whose accessible name
    // (its title) is "Current project: <name>" when a project is active.
    await expect(page.getByRole('button', { name: /Current project/i }).first()).toBeVisible({ timeout: 20_000 });

    // The tree groups assets by type (e.g. Markdown or Agent node present).
    const tree = page.getByRole('tree');
    await expect(tree).toBeVisible({ timeout: 15_000 });
    await expect(tree.getByRole('treeitem').filter({ hasText: /Markdown|Agent|Skill/ }).first()).toBeVisible({ timeout: 15_000 });
    // No "Project" type node in the tree.
    await expect(tree.getByRole('treeitem').filter({ hasText: /^(?:Expand |Collapse )?Project\b/ })).toHaveCount(0);
  });

  test('test 3: Project rows in /dock/assets/list/project are NOT row-click targets', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('/dock/assets/list/project');
    await page.waitForLoadState('networkidle', { timeout: 25_000 }).catch(() => {});
    const firstRow = page.locator('tr:has(td)').first();
    await expect(firstRow).toBeVisible({ timeout: 20_000 });
    // hasEditor('project') is false → AssetsPage leaves onRowClick undefined → no cursor-pointer.
    await expect(firstRow).not.toHaveClass(/cursor-pointer/);
  });
});
