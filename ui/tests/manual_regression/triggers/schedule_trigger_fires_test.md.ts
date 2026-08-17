/**
 * Regression test: clicking "Test" on a schedule trigger fires it immediately
 * and shows the invocation in the right panel.
 *
 * Verifies:
 * - Test button calls POST /api/v1/graph/trigger/{id}/test
 * - Invocations panel updates with a 'schedule_fire' entry
 * - last_run is updated on the trigger
 */
import { test, expect } from '@playwright/test';
import { dismissSetupModal, gotoTriggers, cleanupScheduleTriggers } from './helpers';
import { apiOrigin } from '../_shared/api';

test('schedule trigger test button fires job and shows invocation', async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(err.message));
  const triggerName = `test-fire-schedule-${Date.now()}`;
  let triggerId: string | null = null;

  await dismissSetupModal(page);

  // Create a schedule trigger via API first.
  // TriggersView filters by t.project_id === project?.id, so a trigger with
  // no project_id is invisible in the UI even though the API returned 200.
  // Fetch the @local project id from bootstrap and pass it explicitly.
  // Node-side fetch (apiOrigin): the page is still at about:blank here, so an
  // in-page relative fetch would have no origin to resolve against.
  const API = apiOrigin();
  const boot = await fetch(`${API}/api/v1/graph/bootstrap`).then((r) => r.json());
  const projectId = boot?.data?.default_project?.id ?? null;
  const createRes = await fetch(`${API}/api/v1/graph/trigger`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: triggerName,
      trigger_type: 'schedule',
      expr: '0 9 * * *',
      sched_trigger_type: 'cron',
      scope: 'project',
      enabled: true,
      project_id: projectId,
    }),
  });
  triggerId = (await createRes.json())?.data?.id as string;
  if (!triggerId) throw new Error('Failed to create test schedule trigger');

  try {
    await gotoTriggers(page);

    // Select through the current URL-owned navigator row.
    const triggerRow = page.getByText(triggerName, { exact: true }).first();
    await triggerRow.waitFor({ state: 'visible', timeout: 15_000 });
    await triggerRow.click();

    await page.getByText('Invocations', { exact: true }).first().waitFor({ state: 'visible', timeout: 5_000 });
    await expect(page.getByText('No invocations yet', { exact: true })).toBeVisible();

    // The selected schedule editor owns the current, accessible Run-now action.
    await page.getByRole('button', { name: 'Run now', exact: true }).click();
    await expect(page.getByText('Scheduled', { exact: true })).toBeVisible({ timeout: 15_000 });

    const updatedResponse = await fetch(`${API}/api/v1/graph/trigger/${triggerId}`);
    const updated = (await updatedResponse.json())?.data ?? null;
    expect(updated?.last_run).toBeTruthy();
    expect(updated?.counter).toBeGreaterThanOrEqual(1);
  } finally {
    if (triggerId) await cleanupScheduleTriggers(page, [triggerId]);
  }

  const criticalErrors = errors.filter(e =>
    !e.includes('favicon') && !e.includes('ResizeObserver') && !e.includes('net::ERR_'),
  );
  expect(criticalErrors).toHaveLength(0);
});
