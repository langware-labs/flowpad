/**
 * Flowpad Assistant — project space (asset browser).
 * Source: flowpad_assistant_docs_panel.md
 *
 * /dock/project/@flowpad_assistant renders the project asset browser. The
 * "Flowpad Assistant" button toggles the floating chat (does NOT navigate), so
 * the space is reached by direct navigation. The seeded hello-flowpad doc is
 * reachable as a markdown asset (indexed + searchable).
 */
import { test, expect } from '@playwright/test';
import { apiBase, apiContext } from '../_shared/api';

const API = apiBase();

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
    // Project view header renders "Project assets"; the project scope indicator
    // is the project-name chip (data-testid="project-name-chip"), not a "Project:" label.
    await expect(page.getByText('Project assets').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('project-name-chip').first()).toBeVisible({ timeout: 15_000 });

    const offending = errors.filter((e) => !/ResizeObserver|favicon/.test(e) && !/user-/.test(e) && !/agent_hook/.test(e) && !/\b404\b/.test(e));
    expect(offending, `Console errors: ${offending.join(', ')}`).toHaveLength(0);
  });

  test('test 2: The seeded hello-flowpad doc is indexed and searchable', async () => {
    test.setTimeout(60_000);
    const rq = await apiContext();
    // Index markdown once (the action under test), scoped to the
    // @flowpad_assistant system project — the seeded hello-flowpad doc lives
    // there. Scoping matters: an UNSCOPED `index?type=markdown` still WALKS
    // every registered root (the whole home tree) to discover markdown before
    // filtering, which on a real machine is a ~150s operation that blows this
    // test's 60s cap. The claim under test is only that the SEEDED doc indexes
    // and becomes searchable, so we index exactly that doc's project (one small
    // system-project subtree, ~0.4s) — same action, correct scope. Then poll
    // the search (include_system to reach the seeded system doc) until the FTS
    // commit settles and hello-flowpad surfaces — within the 15s cap.
    // force=true is required, not incidental: the per-file harness reset uses
    // `desktop-db/clear`, which wipes the entity DB + FTS but leaves the on-disk
    // `.hash` index sentinels intact. A plain index then hits skip-fresh (hash
    // still matches) and re-creates the entity rows WITHOUT repopulating FTS, so
    // a search finds nothing. force bypasses skip-fresh and re-writes FTS. (The
    // production rebuild path clears the sentinels itself, so real users never
    // hit this; it is specific to the clear-then-bare-index sequence here.)
    await rq.post(
      `${API}/api/v1/graph/compute_node/@local/fs-records/index?type=markdown&user=false&projects=@flowpad_assistant&force=true`,
    );
    await expect(async () => {
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
    // Asset browser is up (project view header renders "Project assets").
    await expect(page.getByText('Project assets').first()).toBeVisible({ timeout: 15_000 });

    const offending = errors.filter((e) => !/ResizeObserver|favicon/.test(e) && !/user-/.test(e) && !/agent_hook/.test(e) && !/\b404\b/.test(e));
    expect(offending, `Console errors: ${offending.join(', ')}`).toHaveLength(0);
  });
});
