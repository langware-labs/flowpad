/**
 * Flowpad Assistant — project space (asset browser).
 * Source: flowpad_assistant_docs_panel.md
 *
 * /dock/project/@flowpad_assistant renders the project asset browser. The
 * "Flowpad Assistant" button toggles the floating chat (does NOT navigate), so
 * the space is reached by direct navigation. The seeded hello-flowpad doc is
 * reachable as a markdown asset (indexed + searchable).
 */
import { test, expect, request as pwRequest } from '@playwright/test';

const API = process.env.QA_API_URL || 'http://localhost:6003';

test.describe('Flowpad Assistant project space', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('llm-setup-modal-seen', 'true');
      localStorage.setItem('flowpad-index-approved', 'true');
    });
  });

  test('test 1: Open the Flowpad Assistant project space (asset browser)', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto('/dock/project/@flowpad_assistant');
    await page.waitForLoadState('networkidle', { timeout: 25_000 }).catch(() => {});
    await expect(page.locator('body')).not.toContainText('No editor for type: project');
    await expect(page.getByText('Assets', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Project:/).first()).toBeVisible({ timeout: 15_000 });

    const offending = errors.filter((e) => !/ResizeObserver|favicon/.test(e) && !/user-/.test(e) && !/agent_hook/.test(e) && !/\b404\b/.test(e));
    expect(offending, `Console errors: ${offending.join(', ')}`).toHaveLength(0);
  });

  test('test 2: The seeded hello-flowpad doc is indexed and searchable', async () => {
    test.setTimeout(60_000);
    const rq = await pwRequest.newContext();
    // Index markdown, then search (include_system to reach the seeded system doc).
    // The seeded hello-flowpad doc is only searchable AFTER an index pass, and
    // the index POST returns before the FTS commit settles, so re-issue the
    // index inside the poll (the index is the action under test; re-running it
    // is idempotent) and check until the doc surfaces — within the 15s cap.
    await expect(async () => {
      await rq.post(`${API}/api/v1/graph/compute_node/@local/fs-records/index?type=markdown`);
      const res = await rq.get(`${API}/api/v1/search?record_type=markdown&q=hello&include_system=true`);
      expect(res.status()).toBe(200);
      const text = JSON.stringify(await res.json());
      expect(text).toMatch(/hello-flowpad/);
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
    // Asset browser is up.
    await expect(page.getByText('Assets', { exact: true }).first()).toBeVisible({ timeout: 15_000 });

    const offending = errors.filter((e) => !/ResizeObserver|favicon/.test(e) && !/user-/.test(e) && !/agent_hook/.test(e) && !/\b404\b/.test(e));
    expect(offending, `Console errors: ${offending.join(', ')}`).toHaveLength(0);
  });
});
