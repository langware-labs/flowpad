/**
 * Project doc creation — entity-API path.
 * Source: project_room_new_doc.md
 *
 * /dock/project/<id> renders the asset browser (not a legacy DOCS sidebar). Doc
 * creation is exercised via the scoped entity API
 * (POST /api/v1/graph/project/<id>/markdown), the surface the app now uses.
 * The markdown editor opens for an existing doc.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { apiBase, apiContext } from '../_shared/api';

const API = apiBase();

async function firstWritableProjectId(rq: APIRequestContext): Promise<string> {
  const response = await rq.get(`${API}/api/v1/graph/project`);
  expect(response.status()).toBe(200);
  const body = await response.json();
  const projects = Array.isArray(body.data) ? body.data : [body.data];
  const project = projects.find((candidate) => candidate && !candidate.system) ?? projects[0];
  expect(project?.id, 'a writable project id').toMatch(/^[0-9a-f-]{36}$/);
  return project.id;
}

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
    // The project route owns identity; ProjectHome projects it through the
    // pressed scope control rather than a content-header ProjectChip.
    await expect(page.getByText('Project assets').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: /^Current project/ }).first()).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('body')).not.toContainText('No editor for type: project');

    const offending = errors.filter((e) => !/ResizeObserver|favicon/.test(e) && !/user-/.test(e) && !/agent_hook/.test(e) && !/\b404\b/.test(e));
    expect(offending, `Console errors: ${offending.join(', ')}`).toHaveLength(0);
  });

  test('test 2: Creating a markdown doc via the entity API writes the entity (and is searchable)', async () => {
    test.setTimeout(60_000);
    const rq = await apiContext();
    const projectId = await firstWritableProjectId(rq);
    // Mirrors Markdown.createInProject(): the project scope is encoded in the
    // graph path, so save() materializes the file, stamps project_id, and
    // updates FTS before returning.
    const created = await (await rq.post(`${API}/api/v1/graph/project/${projectId}/markdown`, {
      data: { name: 'regression_new_doc_check' },
    })).json();
    expect(created.status).toBe('SUCCESS');
    expect(created.data?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.data?.type).toBe('markdown');
    expect(created.data?.name).toBe('regression_new_doc_check');
    expect(created.data?.project_id).toBe(projectId);
    expect(created.data?.asset_ref).toMatch(/regression_new_doc_check\.md$/);

    await expect(async () => {
      const res = await rq.get(
        `${API}/api/v1/search?record_type=markdown&q=regression_new_doc_check&user=false&projects=${projectId}`,
      );
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.data?.results).toEqual(expect.arrayContaining([
        expect.objectContaining({ record_id: created.data.id, project_id: projectId }),
      ]));
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
    const projectId = await firstWritableProjectId(rq);
    await rq.post(
      `${API}/api/v1/graph/compute_node/@local/fs-records/index?type=markdown&user=false&projects=${projectId}&force=true`,
    );
    await rq.dispose();

    await page.goto('/dock/assets/list/markdown');
    await page.waitForLoadState('networkidle', { timeout: 25_000 }).catch(() => {});

    const firstRow = page.locator('tr:has(td)').first();
    if (await firstRow.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await firstRow.click();
      // markdown has an editor → an asset_ref-backed row click navigates to the editor route.
      // Preserve this navigation oracle's existing callback and polling budget.
      // eslint-disable-next-line @typescript-eslint/require-await
      await expect.poll(async () => page.url(), { timeout: 10_000 }).not.toContain('/dock/assets/list/markdown');
      await expect(page.locator('body')).not.toContainText('No editor for type');
    }

    const offending = errors.filter((e) => !/ResizeObserver|favicon/.test(e) && !/user-/.test(e) && !/agent_hook/.test(e) && !/\b404\b/.test(e));
    expect(offending, `Console errors: ${offending.join(', ')}`).toHaveLength(0);
  });
});
