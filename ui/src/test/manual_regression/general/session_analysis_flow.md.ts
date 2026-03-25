/**
 * Session Analysis UI Flow
 *
 * Verifies that the Recent Activity table responds correctly to
 * analysis Task entities created/updated via the graph CRUD API:
 *
 *   1. Task with status "in_progress" → analyse button shows animated spinner
 *   2. Task updated to "done"         → spinner stops, "Review analysis →" link appears
 *
 * Prerequisites:
 *   - Backend running at http://localhost:9007
 *   - Frontend dev server running at http://localhost:4097 (or VITE_PORT)
 *   - At least one Claude session must be visible in the Sessions tab
 *     (i.e. a Claude project with sessions must be active on the landing page)
 *
 * The test creates real Task entities through the graph API to simulate
 * the analysis lifecycle that useSessionAnalyze normally drives.
 */

import { test, expect } from '@playwright/test';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:9007';
const GRAPH_URL = `${BACKEND_URL}/api/v1/graph`;

/** Ensure bootstrap entities exist. */
async function bootstrap(
  request: Parameters<Parameters<typeof test>[1]>[0]['request'],
): Promise<void> {
  const res = await request.get(`${GRAPH_URL}/bootstrap`);
  if (!res.ok()) {
    const body = await res.text().catch(() => '');
    throw new Error(`Bootstrap failed (${res.status()}): ${body}`);
  }
}

/** Create a Task entity via graph CRUD. Returns the created task's typeId. */
async function createTask(
  request: Parameters<Parameters<typeof test>[1]>[0]['request'],
  fields: Record<string, unknown>,
): Promise<string> {
  const res = await request.post(`${GRAPH_URL}/task`, { data: fields });
  if (!res.ok()) {
    const body = await res.text().catch(() => '');
    throw new Error(`Task create failed (${res.status()}): ${body}`);
  }
  const json = await res.json();
  return json.data?.typeId ?? json.data?.type_id ?? '';
}

/** Update a Task entity via graph CRUD. */
async function updateTask(
  request: Parameters<Parameters<typeof test>[1]>[0]['request'],
  typeId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const res = await request.put(`${GRAPH_URL}/task/${typeId}`, { data: fields });
  if (!res.ok()) {
    const body = await res.text().catch(() => '');
    throw new Error(`Task update failed (${res.status()}): ${body}`);
  }
}

/** Delete a Task entity via graph CRUD (cleanup). */
async function deleteTask(
  request: Parameters<Parameters<typeof test>[1]>[0]['request'],
  typeId: string,
): Promise<void> {
  await request.delete(`${GRAPH_URL}/task/${typeId}`).catch(() => {});
}

test.describe('Session Analysis UI Flow', () => {
  test.beforeEach(async ({ page }) => {
    // Suppress the desktop-setup modal that appears on first load
    await page.addInitScript(() => {
      localStorage.setItem('llm-setup-modal-seen', 'true');
    });
  });

  test('spinner appears for in_progress task, review link appears when done', async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);

    // ── 1. Bootstrap backend entities ──
    await bootstrap(request);

    // ── 2. Load the home page ──
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // ── 3. Switch to the Sessions tab ──
    const sessionsTab = page.getByRole('tab', { name: /sessions/i });
    const tabVisible = await sessionsTab.isVisible({ timeout: 5_000 }).catch(() => false);
    if (!tabVisible) {
      test.skip(true, 'No Sessions tab visible — no project sessions available');
      return;
    }
    await sessionsTab.click();

    // ── 4. Grab the first session row's ID ──
    const firstRow = page.locator('tr[data-session-id]').first();
    const rowVisible = await firstRow.isVisible({ timeout: 5_000 }).catch(() => false);
    if (!rowVisible) {
      test.skip(true, 'No session rows found in the Sessions tab');
      return;
    }
    const sessionId = await firstRow.getAttribute('data-session-id');
    if (!sessionId) {
      test.skip(true, 'Session row has no data-session-id attribute');
      return;
    }

    const analysisPath = `/tmp/test-analysis-${sessionId}.md`;
    let taskTypeId = '';

    try {
      // ── 5. Create an in_progress analysis task for this session ──
      taskTypeId = await createTask(request, {
        title: `Analyse ${sessionId}`,
        status: 'in_progress',
        task_type: 'analysis',
        priority: 'medium',
        tags: ['analysis'],
        metadata: { sessionId, analysisPath },
      });

      // Reload so the task list refreshes (tasks are fetched on mount)
      await page.goto('/');
      await page.waitForLoadState('networkidle');
      await sessionsTab.click();

      // ── 6. Verify the analyse button shows an animated spinner ──
      const analyzeButton = page.locator(
        `tr[data-session-id="${sessionId}"] [data-testid="analyze-button"]`,
      );
      await expect(analyzeButton.locator('.animate-spin')).toBeVisible({ timeout: 8_000 });

      // ── 7. Update the task to "done" ──
      await updateTask(request, taskTypeId, {
        status: 'done',
        metadata: { sessionId, analysisPath, completedAt: new Date().toISOString() },
      });

      // Reload to pick up the updated task
      await page.goto('/');
      await page.waitForLoadState('networkidle');
      await sessionsTab.click();

      // ── 8. Verify the spinner is gone ──
      await expect(analyzeButton.locator('.animate-spin')).not.toBeVisible({ timeout: 8_000 });

      // ── 9. Verify the "Review analysis →" link appears ──
      const reviewLink = page.locator(
        `tr[data-session-id="${sessionId}"] [data-testid="review-analysis-link"]`,
      );
      await expect(reviewLink).toBeVisible({ timeout: 8_000 });
      await expect(reviewLink).toHaveText(/review analysis/i);
    } finally {
      // ── Cleanup: delete the test task ──
      if (taskTypeId) {
        await deleteTask(request, taskTypeId);
      }
    }
  });
});
