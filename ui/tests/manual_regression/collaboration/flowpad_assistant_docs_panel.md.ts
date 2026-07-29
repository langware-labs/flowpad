/**
 * Flowpad Assistant — project space (asset browser).
 * Source: flowpad_assistant_docs_panel.md
 *
 * /dock/project/@flowpad_assistant renders the project asset browser. The
 * "Flowpad Assistant" button toggles the floating chat (does NOT navigate), so
 * the space is reached by direct navigation. The shipped hello-flowpad doc is
 * seeded into the entity and search indexes by startup/reset.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { apiBase, apiContext } from '../_shared/api';

const API = apiBase();

async function assistantProjectId(rq: APIRequestContext): Promise<string> {
  const response = await rq.get(`${API}/api/v1/graph/project/@flowpad_assistant`);
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.status).toBe('SUCCESS');
  expect(body.data?.id).toMatch(/^[0-9a-f-]{36}$/);
  return body.data.id;
}

test.describe('Flowpad Assistant project space', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('llm-setup-modal-seen', 'true');
    });
  });

  test('test 1: Open the Flowpad Assistant project space (asset browser)', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto('/dock/project/@flowpad_assistant');
    await page.waitForLoadState('networkidle', { timeout: 25_000 }).catch(() => {});
    await expect(page.locator('body')).not.toContainText('No editor for type: project');
    // Project identity is URL-owned. The browser projects that scope through
    // the pressed Current project control; ProjectChip belongs to content
    // headers and is not mounted on ProjectHome.
    await expect(page.getByText('Project assets').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: /^Current project/ }).first()).toHaveAttribute('aria-pressed', 'true');

    const offending = errors.filter((e) => !/ResizeObserver|favicon/.test(e) && !/user-/.test(e) && !/agent_hook/.test(e) && !/\b404\b/.test(e));
    expect(offending, `Console errors: ${offending.join(', ')}`).toHaveLength(0);
  });

  test('test 2: The shipped hello-flowpad doc is seeded and searchable', async () => {
    test.setTimeout(60_000);
    const rq = await apiContext();
    const projectId = await assistantProjectId(rq);
    // The Phase 11 per-file reset mirrors production startup: both must seed
    // shipped system markdowns into the entity table and FTS synchronously.
    // No broad/manual re-index is needed (or allowed to hide a broken seed).
    await expect(async () => {
      const res = await rq.get(
        `${API}/api/v1/search?record_type=markdown&q=hello&include_system=true&user=false&projects=${projectId}`,
      );
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.data?.results).toEqual(expect.arrayContaining([
        expect.objectContaining({
          record_id: 'dc8713d4-8841-47ab-a28d-8e3248106f5a',
          name: 'Hello from Flowpad',
          project_id: projectId,
        }),
      ]));
    }).toPass({ timeout: 15_000 });
    await rq.dispose();
  });

  test('test 3: The assistant project view mounts without an error boundary', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto('/dock/project/@flowpad_assistant');
    await page.waitForLoadState('networkidle', { timeout: 25_000 }).catch(() => {});
    // No React error boundary.
    await expect(page.getByText(/Something went wrong/i)).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /^Error$/ })).toHaveCount(0);
    // Asset browser is up (project view header renders "Project assets").
    await expect(page.getByText('Project assets').first()).toBeVisible({ timeout: 15_000 });

    const offending = errors.filter((e) => !/ResizeObserver|favicon/.test(e) && !/user-/.test(e) && !/agent_hook/.test(e) && !/\b404\b/.test(e));
    expect(offending, `Console errors: ${offending.join(', ')}`).toHaveLength(0);
  });
});
