/**
 * Regression test: a scheduled agent run, driven from the agent's own editor.
 *
 * A schedule is a child trigger asset of the agent
 * (`agentic-assets/agent/<name>/agentic-assets/trigger/<slug>/trigger.json`).
 *
 * Verifies:
 * - The Schedule tab pre-fills a new schedule's prompt from the agent's auto-launch prompt
 * - A one-shot schedule set seconds ahead fires, and the row shows it ran
 * - "Runs" opens the run history scoped to the trigger, with one finished run
 * - Clicking the schedule opens the trigger; its pane says "Runs agent <name>" and links back
 * - Editing to a daily time keeps the trigger (same id, run count kept)
 * - Disabling persists across a reload
 * - Deleting removes the row and the trigger
 *
 * The one-second-ahead fire against the real scheduler is pinned by
 * `tests/long_tests/test_scheduled_agent_run_flow.py`; a browser cannot save
 * within one second, so this sets the run a few seconds ahead instead.
 */
import { expect, test } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { apiContext, apiOrigin } from '../_shared/api';
import { dismissSetupModal } from './helpers';

const FIRE_AHEAD_MS = 20_000;

function localInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

test('a scheduled agent run: create, fire, open trigger, edit, disable, delete', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  const api = await apiContext();
  const suffix = Date.now();

  const root = mkdtempSync(path.join(tmpdir(), 'sched-browser-'));
  const project = (await (await api.post('/api/v1/graph/project', {
    data: { type: 'project', name: `sched-browser-${suffix}`, fs_storage_mount_path: root },
  })).json()).data;
  const agent = (await (await api.post(`/api/v1/graph/project/${project.id}/agent`, {
    data: {
      type: 'agent', name: `sched-browser-${suffix}`, title: 'Scheduled brief',
      worker_type: 'claude', model: 'haiku', system_prompt: 'Answer in one word.',
      auto_launch: true, auto_launch_prompt: 'Reply with the single word: briefed',
    },
  })).json()).data;

  await dismissSetupModal(page);
  await page.goto(`/dock/assets/editor/agent/typeid/agent-${agent.id}`);
  await page.getByTestId('agent-tab-schedule').click();

  // ── create: prompt defaults to the auto-launch prompt ──────────────────────
  await page.getByTestId('agent-schedule-add').click();
  await expect(page.getByTestId('agent-schedule-prompt')).toHaveValue('Reply with the single word: briefed');
  const form = page.getByTestId('agent-schedule-form');
  await form.getByPlaceholder('Today').fill('Once soon');
  await form.getByRole('button', { name: 'Once', exact: true }).click();
  await page.getByTestId('cron-run-at').fill(localInputValue(new Date(Date.now() + FIRE_AHEAD_MS)));
  await form.getByRole('button', { name: 'Create', exact: true }).click();

  const row = page.getByTestId('agent-schedule-0');
  await expect(row).toContainText('Once soon');
  await expect(row).toContainText('not run yet');

  // ── it fires ───────────────────────────────────────────────────────────────
  await expect(page.getByTestId('agent-schedule-status-0')).toContainText('ran 1×', { timeout: FIRE_AHEAD_MS + 15_000 });

  const triggers = (await (await api.get('/api/v1/graph/trigger')).json()).data as Array<Record<string, unknown>>;
  const trigger = triggers.find((t) => t.parent_type_id === `agent-${agent.id}`);
  expect(trigger?.id).toBeTruthy();

  // ── runs, scoped to the trigger, finish ────────────────────────────────────
  await page.getByTestId('agent-schedule-runs-0').click();
  await expect(page).toHaveURL(new RegExp(`/dock/process-runs\\?trigger_id=${trigger!.id}`));
  await expect.poll(async () => {
    const runs = (await (await api.get(`/api/v1/runs?trigger_id=${trigger!.id}`)).json()).data.runs;
    return runs.map((r: { badge: string }) => r.badge).join(',');
  }, { timeout: 60_000 }).toBe('done');

  // ── clicking the schedule opens the trigger, which links back ─────────────
  await page.goBack();
  await page.getByTestId('agent-tab-schedule').click();
  await page.getByTestId('agent-schedule-open-0').click();
  await expect(page).toHaveURL(new RegExp(`/dock/events\\?trigger=${trigger!.id}`));
  await expect(page.getByTestId('agent-schedule-detail')).toContainText('Runs agent');
  await page.getByTestId('trigger-runs-agent').click();
  await expect(page).toHaveURL(new RegExp(`/dock/assets/editor/agent/typeid/agent-${agent.id}`));

  // ── edit keeps the trigger ─────────────────────────────────────────────────
  await page.getByTestId('agent-tab-schedule').click();
  await page.getByTestId('agent-schedule-edit-0').click();
  await form.getByPlaceholder('Today').fill('Daily brief');
  await form.getByRole('button', { name: 'Daily', exact: true }).click();
  await form.locator('input[type="time"]').fill('08:30');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('agent-schedule-when-0')).toContainText('Daily at 08:30');
  await expect(page.getByTestId('agent-schedule-status-0')).toContainText('ran 1×');

  // ── disable persists ───────────────────────────────────────────────────────
  await page.getByTestId('agent-schedule-enabled-0').click();
  await expect(page.getByTestId('agent-schedule-enabled-0')).toHaveAttribute('data-state', 'unchecked');
  await page.reload();
  await page.getByTestId('agent-tab-schedule').click();
  await expect(page.getByTestId('agent-schedule-enabled-0')).toHaveAttribute('data-state', 'unchecked');

  // ── delete ─────────────────────────────────────────────────────────────────
  await page.getByTestId('agent-schedule-delete-0').click();
  await page.getByTestId('delete-asset-modal-confirm').click();
  await expect(page.getByTestId('agent-no-schedules')).toBeVisible();
  const gone = await (await api.get(`${apiOrigin()}/api/v1/graph/trigger/${trigger!.id}`)).json();
  expect(gone.status === 'SUCCESS' && gone.data ? gone.data.id : null).toBeNull();

  expect(errors).toHaveLength(0);
});
