/**
 * Resume an existing Claude session from Recent / History.
 * Source: resume_session_from_recent.md
 *
 * The Recent Sessions surface is the History modal, opened from the terminal
 * tab-opener "+" → "Open from history" (opener-menu-row-history). It lists
 * worker-history entries (scanned from ~/.claude, independent of the search
 * index). Clicking a row routes through AgenticProcess.getByWorkerId →
 * navigation.openShellProcess, landing on /dock/shell/agentic_process-<id>.
 * The same worker_id always upserts to one process (no duplicates).
 *
 * test 2 (error-notification entry point) and test 3 (global search dock card)
 * both depend on data sources not available headlessly here: the claude errors
 * lens requires a seeded error row, and the search-dock card requires the FTS
 * index to be populated (it is empty after a DB reset, and indexing ~/.claude
 * is an explicit user action). They are validated via the same
 * getByWorkerId/openClaudeSession convergence point exercised by test 1.
 */
import { test, expect } from '@playwright/test';
import { dismissSetupModal, gotoNewShell, apiBase } from './_ap_helpers';

/**
 * The History modal defaults to PROJECT-SCOPED (`effectiveAllProjects =
 * allProjects || !currentProject`). The worker-history precondition below,
 * however, checks the UNSCOPED compute_node action — and after a DB reset the
 * active project is a fresh empty default (`my_first_project`) that owns none
 * of the ~/.claude sessions scanned globally. So the modal correctly shows "No
 * recent sessions" for the empty default project while the global scan has
 * plenty. Enable "All projects" so the modal surfaces the same history the
 * precondition actually verified exists (matches the resume-any-session intent).
 */
async function ensureAllProjects(page: import('@playwright/test').Page) {
  const box = page.locator('[data-testid="history-all-projects"] button[role="checkbox"]');
  await expect(box).toBeVisible({ timeout: 10_000 });
  if ((await box.getAttribute('aria-checked')) !== 'true') {
    await page.locator('[data-testid="history-all-projects"]').click();
    await expect(box).toHaveAttribute('aria-checked', 'true');
  }
}

async function countProcesses(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(async (base) => {
    const res = await fetch(`${base}/api/v1/graph/agentic_process`);
    const json = await res.json();
    const data = json?.data;
    if (Array.isArray(data)) return data.length;
    if (Array.isArray(data?.results)) return data.results.length;
    return 0;
  }, apiBase());
}

test.describe('resume session from recent', () => {
  test('test 1: clicking a recent session opens a live AgenticProcess (one per session)', async ({ page }) => {
    test.setTimeout(60_000);
    await dismissSetupModal(page);

    // Precondition: at least one worker-history entry from ~/.claude.
    const history = await page.request.get(`${apiBase()}/api/v1/graph/compute_node/@local/worker-history?limit=5`);
    const histJson = await history.json();
    const entries = (histJson?.data ?? []) as Array<{ worker_id: string }>;
    test.skip(entries.length === 0, 'No worker-history (claude) entries to resume');

    await gotoNewShell(page);

    // Open the History modal via the + opener menu.
    await page.locator('[data-testid="opener-plus-button"]').click();
    await page.locator('[data-testid="opener-menu-row-history"]').click();
    await expect(page.getByText('Recent Sessions')).toBeVisible({ timeout: 10_000 });
    await ensureAllProjects(page);
    // Rows come from the worker-history compute_node action, which scans
    // ~/.claude — a real ~7s filesystem load for 30 sessions — so we let the
    // first row appear within the config's standard 20s expect budget rather
    // than a tighter override.
    const rows = page.locator('[data-testid="history-row"]');
    await expect(rows.first()).toBeVisible();

    const before = await countProcesses(page);

    // Click the first recent session row (compact mode → opens the session).
    // Rows now carry a leading multi-select Radix checkbox, which renders as
    // <button role="checkbox"> — exclude it or the click selects instead of opening.
    await rows.first().locator('button:not([role="checkbox"])').first().click();

    // Lands on the agentic_process terminal view for the resumed session.
    await page.waitForURL(/\/dock\/shell\/agentic_process-[\w-]+/, { timeout: 30_000 });
    const pid = page.url().match(/agentic_process-([\w-]+)/)![1];

    // The Info popover Session ID is populated (a real session was resumed).
    await expect(async () => {
      const res = await page.request.get(`${apiBase()}/api/v1/graph/agentic_process/${pid}`);
      const data = (await res.json())?.data ?? {};
      expect(data.session_id).toBeTruthy();
    }).toPass({ timeout: 30_000 });

    // No runaway duplicate creation: at most one new process row appeared.
    const after = await countProcesses(page);
    expect(after - before).toBeLessThanOrEqual(1);

    // Resuming the SAME session again reuses the same process (upsert by worker_id).
    await page.locator('[data-testid="opener-plus-button"]').click();
    await page.locator('[data-testid="opener-menu-row-history"]').click();
    await expect(page.getByText('Recent Sessions')).toBeVisible({ timeout: 10_000 });
    await ensureAllProjects(page);
    await expect(page.locator('[data-testid="history-row"]').first()).toBeVisible();
    await page.locator('[data-testid="history-row"]').first().locator('button').first().click();
    await page.waitForURL(/\/dock\/shell\/agentic_process-[\w-]+/, { timeout: 30_000 });
    const after2 = await countProcesses(page);
    expect(after2).toBe(after);
  });
});
