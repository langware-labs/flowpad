/**
 * Spawned AgenticProcess is attached to its Trigger via target_typeid_str.
 * Source: trigger_process_target_typeid_str.md
 *
 * Schedule-trigger fire sets target_typeid_str="trigger-<id>" on the spawned
 * process; the filtered list returns it; the TriggerInvocationsPanel renders a
 * "Scheduled" row. Steps 1-4 (API) are the binding pass criteria; step 5 (UI)
 * is soft. Schedule triggers MUST be created with project_id.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { dismissSetupModal, gotoTriggers } from './helpers';
import { apiBase, apiContext } from '../_shared/api';

const API = apiBase();

function targetQuery(tid: string): string {
  // QueryFilter.match on target_typeid_str === "trigger-<tid>"
  const p = new URLSearchParams();
  p.set('filter[match][op]', '$EQ');
  p.set('filter[match][operands][0]', 'target_typeid_str');
  p.set('filter[match][operands][1]', `trigger-${tid}`);
  return p.toString();
}

async function processesForTrigger(rq: APIRequestContext, tid: string): Promise<Array<{ target_typeid_str: string }>> {
  const res = await rq.get(`${API}/api/v1/graph/agentic_process?${targetQuery(tid)}`);
  expect(res.status()).toBe(200);
  return (await res.json()).data ?? [];
}

test('trigger fire attaches process via target_typeid_str + panel shows invocation', async ({ page }) => {
  test.setTimeout(60_000);
  await dismissSetupModal(page);
  const rq = await apiContext();

  const boot = (await (await rq.get(`${API}/api/v1/graph/bootstrap`)).json()).data;
  const projectId = typeof boot.default_project === 'string' ? boot.default_project : boot.default_project?.id;
  expect(projectId).toBeTruthy();

  // 1. Create a schedule trigger with an instruction (project_id required).
  const created = await (await rq.post(`${API}/api/v1/graph/trigger`, {
    data: {
      name: 'qa-target-typeid-str',
      trigger_type: 'schedule',
      sched_trigger_type: 'cron',
      expr: '0 9 * * *',
      scope: 'user',
      enabled: true,
      instruction: 'echo trigger-target-typeid-probe',
      project_id: projectId,
    },
  })).json();
  expect(created.status).toBe('SUCCESS');
  const tid: string = created.data.id;
  expect(tid).toMatch(/^[0-9a-f-]{36}$/);

  try {
    // 2. No pre-existing rows for this fresh trigger.
    expect((await processesForTrigger(rq, tid)).length).toBe(0);

    // 3. Fire the trigger.
    const fired = await (await rq.post(`${API}/api/v1/graph/trigger/${tid}/test`)).json();
    const fireStatus = fired.status === 'SUCCESS' ? fired.data?.status : fired.status;
    expect(fireStatus).toBe('fired');
    expect(fired.data?.counter ?? 0).toBeGreaterThan(0);

    // 4. The spawned process carries the serialized key (poll — spawn is async).
    await expect(async () => {
      const rows = await processesForTrigger(rq, tid);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.some((p) => p.target_typeid_str === `trigger-${tid}`)).toBe(true);
    }).toPass({ timeout: 15_000 });

    // 5. UI (soft): TriggerInvocationsPanel shows a "Scheduled" invocation row.
    await gotoTriggers(page);
    const triggerItem = page.getByText('qa-target-typeid-str').first();
    if (await triggerItem.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await triggerItem.click();
      await expect(page.getByText('Invocations').first()).toBeVisible({ timeout: 10_000 });
      // Scheduled label may take a moment to load from TriggerLogRecord.
      await page.getByText('Scheduled').first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
    }
  } finally {
    // 6. Cleanup.
    await rq.delete(`${API}/api/v1/graph/trigger/${tid}`);
  }

  await rq.dispose();
});
