/**
 * GraphWorkflow browser validation — the two demo flows, driven through the
 * real canvas UI (no engine shortcuts): open the per-flow dock, inject an event
 * from the Inject panel, then watch the Runs panel + journal report a complete
 * run with every node's execution.
 *
 * Covered demos:
 *  - `demo-relay-chain` — `$external` edge entry → two inline `flow_relay` hops
 *    → a `scripts/stamp.py` SUBPROCESS function → inline `flow_echo`.
 *  - `mini-analyzer` (seeded) — trigger node + `scripts/mini_analyzer.py`
 *    subprocess → inline `flow_echo`; injected at the analyzer node (the
 *    Inject panel's direct-delivery mode), so its `summary` edge still routes.
 *
 * The `demo-relay-chain` row is created here if this instance has never seen
 * it (folder assets live in the shared user home, DB rows are per-instance).
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { apiBase } from '../_shared/api';

const API = apiBase();

const RELAY_FLOW = 'demo-relay-chain';
const MINI_FLOW = 'mini-analyzer';

type Envelope<T> = { status: string; data: T };
type FlowRow = { id: string; name: string; asset_ref: string; enabled: boolean };

async function flowByName(request: APIRequestContext, name: string): Promise<FlowRow | undefined> {
  const response = await request.get(`${API}/api/v1/graph/graph_workflow`);
  expect(response.status()).toBe(200);
  const body = (await response.json()) as Envelope<FlowRow[]>;
  expect(body.status).toBe('SUCCESS');
  return body.data.find((row) => row.name === name);
}

/** The relay demo's folder (shared user home) — the flow's semantic truth. */
function relayFolder(): string {
  return path.join(os.homedir(), 'agentic-assets', 'graph_workflow', RELAY_FLOW);
}

async function ensureRelayFlow(request: APIRequestContext): Promise<FlowRow> {
  const existing = await flowByName(request, RELAY_FLOW);
  if (existing) return existing;
  const folder = relayFolder();
  expect(fs.existsSync(path.join(folder, 'graph.json')), `${folder}/graph.json must exist`).toBe(true);
  const created = await request.post(`${API}/api/v1/graph/graph_workflow`, {
    data: { name: RELAY_FLOW, asset_ref: folder, enabled: true },
  });
  expect(created.status()).toBe(200);
  const row = await flowByName(request, RELAY_FLOW);
  expect(row, 'relay demo flow row').toBeTruthy();
  return row!;
}

async function dismissSetup(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  });
}

/** Open a flow's dock tab and wait for the canvas topbar to report its shape. */
async function openFlow(page: Page, flow: FlowRow, shape: string) {
  await page.goto(`/dock/graph-workflows/graph_workflow-${flow.id}?viewMode=dev`);
  const topbar = page.locator('.graph-workflows .topbar');
  await expect(topbar.getByText(flow.name, { exact: true })).toBeVisible();
  await expect(topbar.getByText(shape, { exact: true })).toBeVisible();
  // The flow must be active and the liveness stream connected, or the run
  // surfaces below would be dark for reasons that have nothing to do with the flow.
  await expect(topbar.getByRole('button', { name: 'active' })).toBeVisible();
  await expect(topbar.locator('.chip', { hasText: 'live' }).locator('.dot.ok')).toBeVisible();
}

/** Inject through the panel UI; returns the short run id the panel reports. */
async function injectFromPanel(
  page: Page,
  { event, payload, targetNode }: { event: string; payload: string; targetNode?: string },
): Promise<string> {
  await page.locator('.graph-workflows .topbar').getByRole('button', { name: 'inject' }).click();
  const panel = page.locator('.afl-inject');
  await expect(panel).toBeVisible();
  await panel.locator('input').fill(event);
  await panel.locator('textarea').fill(payload);
  if (targetNode) await panel.locator('select').selectOption({ label: targetNode });
  await panel.getByRole('button', { name: 'Inject ▶' }).click();
  const status = panel.locator('.afl-status');
  await expect(status).toContainText(/^▶ run [0-9a-f]{8}$/);
  return (await status.innerText()).replace('▶ run ', '').trim();
}

/** Select the run in the Runs panel once it completes; returns its journal rows. */
async function completedRunJournal(page: Page, shortRunId: string) {
  await page.locator('.graph-workflows .topbar').getByRole('button', { name: 'runs' }).click();
  const runRow = page.locator('.afl-runrow', { has: page.locator('.id', { hasText: shortRunId }) });
  await expect(runRow).toHaveClass(/complete/);
  await expect(runRow.locator('.g')).toHaveText('✓');
  // The panel auto-focuses the live run on its run_start beat, so only click
  // when it is not already the selected row — a click would toggle it off.
  if (!(await runRow.getAttribute('class'))!.includes('on')) await runRow.click();
  await expect(runRow).toHaveClass(/\bon\b/);
  return page.locator('.afl-journal .afl-jrow');
}

/** Node ids that reported `node_done` in the rendered journal timeline. */
async function doneNodes(page: Page): Promise<string[]> {
  const rows = page.locator('.afl-journal .afl-jrow.node_done');
  await expect(rows.first()).toBeVisible();
  const labels = await rows.locator('.n').allInnerTexts();
  return labels.map((label) => label.split('·').pop()!.trim());
}

test.beforeEach(async ({ page }) => {
  await dismissSetup(page);
});

test('demo-relay-chain runs end to end from the canvas (inline chain + subprocess node)', async ({
  page,
  request,
}) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  const flow = await ensureRelayFlow(request);
  await openFlow(page, flow, '4 nodes · 4 edges');

  const canvas = page.locator('.graph-workflows .react-flow');
  for (const label of ['Relay 1', 'Relay 2', 'Stamp (subprocess)', 'Log result']) {
    await expect(canvas.getByText(label, { exact: true })).toBeVisible();
  }

  const shortRunId = await injectFromPanel(page, {
    event: 'go',
    payload: JSON.stringify({ from: 'browser-validation' }),
  });
  const journal = await completedRunJournal(page, shortRunId);
  expect(await doneNodes(page)).toEqual(expect.arrayContaining(['relay-1', 'relay-2', 'stamp', 'echo']));

  // The chain's semantics, not just its liveness: two relay hops counted, and
  // the subprocess node stamped the payload from its own process.
  await expect(journal.filter({ hasText: 'stamped' }).first()).toContainText('"hops":2');
  await expect(journal.filter({ hasText: 'stamped_by' }).first()).toContainText('scripts/stamp.py');

  await page.screenshot({ path: test.info().outputPath('relay-chain-run.png'), fullPage: false });

  expect(pageErrors).toEqual([]);
  expect(consoleErrors.filter((message) => !/ResizeObserver|favicon/i.test(message))).toEqual([]);
});

test('mini-analyzer runs end to end from the canvas (seeded demo flow)', async ({ page, request }) => {
  const flow = await flowByName(request, MINI_FLOW);
  expect(flow, `${MINI_FLOW} must be seeded on this instance`).toBeTruthy();
  await openFlow(page, flow!, '3 nodes · 2 edges');

  const canvas = page.locator('.graph-workflows .react-flow');
  await expect(canvas.getByText('Mini analyzer', { exact: true })).toBeVisible();
  await expect(canvas.getByText('Log summary', { exact: true })).toBeVisible();
  // The trigger node is output-only and says so on its face.
  await expect(canvas.getByText('fired ⟶', { exact: true })).toBeVisible();

  const shortRunId = await injectFromPanel(page, {
    event: 'fired',
    payload: '{}',
    targetNode: 'Mini analyzer',
  });
  const journal = await completedRunJournal(page, shortRunId);
  expect(await doneNodes(page)).toEqual(expect.arrayContaining(['analyzer', 'echo']));
  // The analyzer's own event carried its summary onward to the echo node.
  await expect(journal.filter({ hasText: 'processes_total' }).first()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('mini-analyzer-run.png'), fullPage: false });
});
