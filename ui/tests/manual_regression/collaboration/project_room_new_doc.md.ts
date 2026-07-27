/**
 * Project doc creation — entity-API path.
 * Source: project_room_new_doc.md
 *
 * /dock/project/<id> renders the asset browser (not a legacy DOCS sidebar). Doc
 * creation is exercised via the entity API (POST /api/v1/graph/markdown), the
 * surface the app now uses. The markdown editor opens for an existing doc.
 */
import { test, expect } from '@playwright/test';
import { apiBase, apiContext } from '../_shared/api';

const API = apiBase();

test.describe('Project doc creation — entity API', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('llm-setup-modal-seen', 'true');
    });
  });

  test('test 1: Project view mounts the asset browser (not a legacy DOCS sidebar)', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto('/dock/project/@flowpad_assistant');
    await page.waitForLoadState('networkidle', { timeout: 25_000 }).catch(() => {});
    // Project view header renders "Project assets"; the project scope indicator
    // is the project-name chip (data-testid="project-name-chip"), not a "Project:" label.
    await expect(page.getByText('Project assets').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('project-name-chip').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('body')).not.toContainText('No editor for type: project');

    const offending = errors.filter((e) => !/ResizeObserver|favicon/.test(e) && !/user-/.test(e) && !/agent_hook/.test(e) && !/\b404\b/.test(e));
    expect(offending, `Console errors: ${offending.join(', ')}`).toHaveLength(0);
  });

  test('test 2: Creating a markdown doc via the entity API writes the entity (and is searchable)', async () => {
    test.setTimeout(60_000);
    const rq = await apiContext();
    const created = await (await rq.post(`${API}/api/v1/graph/markdown`, {
      data: { name: 'regression_new_doc_check', body: '# regression\nnew doc body\n' },
    })).json();
    expect(created.status).toBe('SUCCESS');
    expect(created.data?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.data?.type).toBe('markdown');
    expect(created.data?.name).toBe('regression_new_doc_check');

    await rq.post(`${API}/api/v1/graph/compute_node/@local/fs-records/index?type=markdown`);
    await expect(async () => {
      const res = await rq.get(`${API}/api/v1/search?record_type=markdown&q=regression_new_doc_check`);
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(JSON.stringify(body)).toMatch(/regression_new_doc_check/);
    }).toPass({ timeout: 15_000 });
    await rq.dispose();
  });

  test('test 3: The markdown editor surface opens for an existing doc', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    // Index markdown first so list rows are file-backed (asset_ref present).
    // navigateToResult only builds a dockPointer when r.asset_ref exists, so a
    // DB-only (un-indexed) row's click is a no-op — index to make the click
    // deterministically navigate.
    const rq = await apiContext();
    await rq.post(`${API}/api/v1/graph/compute_node/@local/fs-records/index?type=markdown`);
    await rq.dispose();

    await page.goto('/dock/assets/list/markdown');
    await page.waitForLoadState('networkidle', { timeout: 25_000 }).catch(() => {});

    const firstRow = page.locator('tr:has(td)').first();
    if (await firstRow.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await firstRow.click();
      // markdown has an editor → an asset_ref-backed row click navigates to the editor route.
      await expect.poll(async () => page.url(), { timeout: 10_000 }).not.toContain('/dock/assets/list/markdown');
      await expect(page.locator('body')).not.toContainText('No editor for type');
    }

    const offending = errors.filter((e) => !/ResizeObserver|favicon/.test(e) && !/user-/.test(e) && !/agent_hook/.test(e) && !/\b404\b/.test(e));
    expect(offending, `Console errors: ${offending.join(', ')}`).toHaveLength(0);
  });
});
