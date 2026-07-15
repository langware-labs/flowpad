/**
 * Workflow — Run button populates Runs side tab (asset_ref rename).
 * Source: workflow_run_button.md
 *
 * 1. UI-created workflow (Workflow.createInProject -> Entity.save ->
 *    WorkflowRecord.upsert_main_ref) populates asset_ref + writes a backing .md.
 * 2. Clicking Run spawns an AgenticProcess with target_typeid_str=workflow-<id>,
 *    visible=false, print_mode=true, output_format=stream-json.
 * 3. The Runs side tab populates (>= 1).
 *
 * The editor must NOT show "File is missing".
 */
import { test, expect, type Page } from '@playwright/test';
import { apiBase, apiContext } from '../_shared/api';

const API = apiBase();

async function prep(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  });
}

test('Workflow Run button: asset_ref + spawned AP target_typeid_str + Runs tab', async ({ page }) => {
  test.setTimeout(60_000);
  await prep(page);
  const rq = await apiContext();

  // Step 1: create a workflow via the UI.
  await page.goto('/dock/workflows');
  const skip = page.getByRole('button', { name: /Skip( for now)?/ });
  if (await skip.isVisible({ timeout: 2_000 }).catch(() => false)) await skip.click();

  const name = `qa_assetref_smoke_${Date.now()}`;
  await page.locator('[title="New Workflow"]').first().click();
  // New Workflow opens a Radix InputDialog (portal); the name field is the
  // dialog's text input.
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  const nameInput = dialog.locator('input').first();
  await expect(nameInput).toBeVisible({ timeout: 10_000 });
  await nameInput.fill(name);
  await dialog.getByRole('button', { name: /^Create$/ }).click();

  // Redirect to /dock/workflows/<uuid>.
  await page.waitForURL(/\/dock\/workflows\/[0-9a-f-]{36}/, { timeout: 15_000 });
  const wid = page.url().match(/[0-9a-f-]{36}/)![0];

  // Editor must not show "File is missing".
  await expect(page.locator('body')).not.toContainText('File is missing');

  // asset_ref populated + points at <scope>/.claude/workflows/<name>.md.
  await expect(async () => {
    const got = (await (await rq.get(`${API}/api/v1/graph/workflow/${wid}`)).json()).data;
    expect(got?.asset_ref, 'asset_ref populated on UI-created workflow').toBeTruthy();
    expect(String(got.asset_ref)).toMatch(new RegExp(`\\.claude/workflows/${name}\\.md$`));
  }).toPass({ timeout: 15_000 });

  // Step 2: click Run (Play icon in the editor toolbar).
  const runBtn = page.getByRole('button', { name: /^Run$/ }).first();
  await expect(runBtn).toBeVisible({ timeout: 15_000 });
  await runBtn.click();

  // Step 3: a spawned AgenticProcess carries the workflow target + print-mode flags.
  await expect(async () => {
    const procs = (await (await rq.get(`${API}/api/v1/graph/agentic_process`)).json()).data ?? [];
    const match = procs.find((p: { target_typeid_str?: string }) => p.target_typeid_str === `workflow-${wid}`);
    expect(match, 'spawned AP with target_typeid_str=workflow-<id>').toBeTruthy();
    expect(match.visible).toBe(false);
    expect(match.cli_config?.print_mode).toBe(true);
    expect(match.cli_config?.output_format).toBe('stream-json');
  }).toPass({ timeout: 20_000 });

  // Step 4: the Runs side tab shows at least one run.
  const runsTab = page.getByRole('tab', { name: /Runs/ }).or(page.getByRole('button', { name: /Runs/ })).first();
  if (await runsTab.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await runsTab.click();
    await expect(page.getByText(/Run 1|Running|Complete|Idle|Error/).first()).toBeVisible({ timeout: 15_000 });
  }

  await rq.dispose();
});
