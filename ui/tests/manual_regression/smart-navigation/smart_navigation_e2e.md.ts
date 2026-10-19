/**
 * Smart navigation end to end — ./smart_navigation_e2e.md.
 *
 * The person: the magic line navigates a dock or asks the assistant the prompt. The data scientist:
 * with SmartNavigationLog on, each decision is a `train` row of SmartNavigationLog, reviewed in
 * the dataset editor ("Correct") into a labelled training set. Ground truth is read from the
 * backend and the disk (the instance's preferences.json, the dataset's rows), never from timing.
 *
 * Counts are deltas, so the spec runs on an instance that already has a log.
 */
import { expect, test, type Frame, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apiContext } from '../_shared/api';

const PREF = 'preferences.advanced.smart_navigation_log';
const INSTANCE = process.env.FLOW_INSTANCE ?? '';
const PREFS_FILE = path.join(os.homedir(), '.flow', 'instances', INSTANCE, 'preferences.json');

type Row = { id: string; kind: string; input: any; output: any; ground_truth: any; data: any };

function prefOn(): boolean {
  return existsSync(PREFS_FILE) && JSON.parse(readFileSync(PREFS_FILE, 'utf-8'))[PREF] === true;
}

async function logDataset(): Promise<{ id: string } | null> {
  const api = await apiContext();
  const res = await api.get(`/api/v1/graph/dataset?filter=${encodeURIComponent('{"name":"SmartNavigationLog"}')}`);
  const [row] = ((await res.json()).data ?? []) as { id: string }[];
  return row ?? null;
}

async function logRows(): Promise<Row[]> {
  const ds = await logDataset();
  if (!ds) return [];
  const api = await apiContext();
  return ((await (await api.get(`/api/v1/graph/dataset/${ds.id}/rows`)).json()).data.rows ?? []) as Row[];
}

async function ask(page: Page, text: string): Promise<void> {
  await page.getByTestId('top-nav-address').click();
  const input = page.getByTestId('top-nav-ask-input');
  await input.fill(text);
  await input.press('Enter');
}

async function editorFrame(page: Page): Promise<Frame> {
  await expect
    .poll(async () => {
      for (const f of page.frames()) {
        if (
          await f
            .locator('[data-testid="dataset-editor-rows"] tr')
            .count()
            .catch(() => 0)
        )
          return true;
      }
      return false;
    })
    .toBe(true);
  for (const f of page.frames()) {
    if (
      await f
        .locator('[data-testid="dataset-editor-rows"] tr')
        .count()
        .catch(() => 0)
    )
      return f;
  }
  throw new Error('no dataset editor frame');
}

test.describe.serial('smart navigation', () => {
  test.beforeAll(() => {
    expect(INSTANCE, 'run with FLOW_INSTANCE=<instance>').not.toBe('');
  });

  test('off logs nothing; on, every decision is a train row and the line still navigates or asks', async ({ page }) => {
    test.skip(prefOn(), 'the log is already on for this instance — turn it off to run this leg');
    // One count across both legs: a decision logged while OFF would make the total +4, not +3.
    const before = (await logRows()).length;
    await page.goto('/dock/automations');
    await ask(page, 'open data sources');
    await expect(page).toHaveURL(/\/dock\/data-sources$/);

    await page.goto('/dock/preferences/advanced');
    await page.locator(`[id="pref-${PREF}"]`).click();
    await expect.poll(prefOn, { message: 'the switch is saved to preferences.json' }).toBe(true);

    await ask(page, 'open data sources');
    await expect(page).toHaveURL(/\/dock\/data-sources$/);
    await ask(page, 'take me to preferences');
    await expect(page).toHaveURL(/\/dock\/preferences/);
    await ask(page, 'summarize the README');
    await expect(page.getByTestId('assistant-chat')).toBeVisible();

    await expect.poll(async () => (await logRows()).length).toBe(before + 3);
    const rows = (await logRows()).slice(-3);
    const byText = Object.fromEntries(rows.map((r) => [r.input.utterance, r]));
    expect(Object.keys(byText).sort()).toEqual(['open data sources', 'summarize the README', 'take me to preferences']);
    expect(byText['open data sources'].data.address).toBe('/dock/data-sources');
    expect(byText['open data sources'].input.here.view).toBeTruthy();
    expect(byText['summarize the README'].data.prompt).toBe('summarize the README');
    expect(byText['summarize the README'].output.route).toBe('agentic');
    for (const r of rows) expect([r.kind, r.ground_truth ?? null]).toEqual(['train', null]);

    const ds = (await logDataset())!;
    const api = await apiContext();
    const checked = (await (await api.post(`/api/v1/graph/dataset/${ds.id}/validate`)).json()).data;
    expect(checked.problems).toEqual([]);
  });

  test('review: "Correct" in the dataset editor labels a row', async ({ page }) => {
    const ds = (await logDataset())!;
    const api = await apiContext();
    const [editor] = (await (await api.get(`/api/v1/editors/dataset-${ds.id}`)).json()).data;
    await page.goto(`/dock/app/${editor.typeid}?subject=dataset-${ds.id}`);
    const frame = await editorFrame(page);
    await frame.locator('[data-testid="dataset-editor-filter"]').selectOption('needs-label');
    const unlabelled = (await logRows()).filter((r) => r.output && r.ground_truth == null).length;
    const correct = frame.locator('[data-testid^="dataset-editor-correct-"]').first();
    await correct.click();
    await expect
      .poll(async () => (await logRows()).filter((r) => r.output && r.ground_truth == null).length)
      .toBe(unlabelled - 1);
    const labelled = (await logRows()).filter((r) => r.ground_truth != null);
    expect(labelled.length).toBeGreaterThan(0);
  });
});
