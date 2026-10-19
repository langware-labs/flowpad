/**
 * Automations — browser stress validation (P5 of the redesign, docs/automations.md).
 *
 * Seeds a realistic mix (event, schedule and file automations, some failing, one
 * storm-guarded), builds more through the UI, bursts events, runs tests
 * concurrently, flips switches fast and navigates the three places over and
 * over — and asserts the screen stays truthful: every fire shows up in Runs with
 * the right status and error, failures are named up front, no row is
 * duplicated, old Events links still land, and nothing throws or 5xx's.
 *
 * Screenshots of each place (light and dark) go to $AUTOMATIONS_SHOTS (default
 * test-results/automations-shots).
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { apiContext } from '../_shared/api';
import { dismissSetupModal } from '../triggers/helpers';

const SHOTS = process.env.AUTOMATIONS_SHOTS || path.resolve('test-results/automations-shots');
const RUN = Math.random().toString(36).slice(2, 7);
const T = `/api/v1/graph/trigger`;
const MISSING_AGENT = 'agent-00000000-0000-4000-8000-000000000000';

/** Explicit budget for this spec — it seeds, bursts and navigates on purpose. */
const SPEC_BUDGET_MS = 300_000;

type Created = { id: string; name: string };

async function create(rq: APIRequestContext, body: Record<string, unknown>): Promise<Created> {
  const res = await rq.post(`${T}/create`, { data: body });
  expect(res.status(), await res.text()).toBe(200);
  const data = (await res.json()).data;
  return { id: data.id, name: data.name };
}

async function runsFor(rq: APIRequestContext, id: string, extra = ''): Promise<Array<Record<string, any>>> {
  const res = await rq.get(`${T}/runs?trigger_id=${id}&limit=500${extra}`);
  expect(res.status()).toBe(200);
  return (await res.json()).data;
}

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({ path: path.join(SHOTS, `${name}-${scheme}.png`), fullPage: false });
  }
  await page.emulateMedia({ colorScheme: 'dark' });
}

/** Time from a navigation to the place's own test id being visible. */
async function timed(page: Page, go: () => Promise<unknown>, testId: string): Promise<number> {
  const started = Date.now();
  await go();
  await page.getByTestId(testId).first().waitFor({ state: 'visible' });
  return Date.now() - started;
}

test('the Automations screen stays truthful under load', async ({ page }) => {
  test.setTimeout(SPEC_BUDGET_MS);
  const rq = await apiContext();
  const created: Created[] = [];
  const pageErrors: string[] = [];
  const badResponses: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('response', (r) => {
    if (r.url().includes('/graph/trigger') && r.status() >= 400 && r.status() !== 404 && r.status() !== 422) {
      badResponses.push(`${r.status()} ${r.request().method()} ${r.url()}`);
    }
  });

  try {
    // ── Seed: 6 event, 3 failing event, 1 storm-guarded, 5 schedule, 4 file ─────────
    const ok: Created[] = [];
    for (let i = 0; i < 6; i++) {
      ok.push(await create(rq, { name: `stress ok ${RUN}-${i}`, trigger_type: 'tag', tag_pattern: `st${RUN}.ok${i}.*` }));
    }
    const failing: Created[] = [];
    for (let i = 0; i < 3; i++) {
      failing.push(
        await create(rq, {
          name: `stress fails ${RUN}-${i}`,
          trigger_type: 'tag',
          tag_pattern: `st${RUN}.fail${i}.*`,
          actions: [{ action_type: 'run_agent', target_type_id: MISSING_AGENT, prompt: 'never runs' }],
        }),
      );
    }
    const storm = await create(rq, {
      name: `stress storm ${RUN}`,
      trigger_type: 'tag',
      tag_pattern: `st${RUN}.storm.*`,
      max_fires_per_minute: 5,
    });
    const schedules: Created[] = [];
    for (const [i, expr] of ['0 9 * * 1-5', '30 7 * * *', '0 12 * * 1', '15 6 1 * *', '0 18 * * 5'].entries()) {
      schedules.push(await create(rq, { name: `stress schedule ${RUN}-${i}`, trigger_type: 'schedule', expr, sched_trigger_type: 'cron' }));
    }
    const files: Created[] = [];
    for (let i = 0; i < 4; i++) {
      const dir = mkdtempSync(path.join(tmpdir(), `auto-stress-${RUN}-`));
      files.push(await create(rq, { name: `stress file ${RUN}-${i}`, trigger_type: 'fsop', watch_path: dir, watch_glob: '*.md' }));
    }
    created.push(...ok, ...failing, storm, ...schedules, ...files);

    // ── The list renders every one of them, once ─────────────────────────────────────
    await dismissSetupModal(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/dock/automations');
    const skip = page.getByRole('button', { name: 'Skip' });
    if (await skip.isVisible({ timeout: 2_000 }).catch(() => false)) await skip.click();
    await page.getByTestId('automations-list').waitFor();
    for (const a of created) await expect(page.getByTestId(`automation-row-${a.id}`)).toHaveCount(1);
    await shot(page, '01-list');

    // ── Build two through the UI: a schedule and an event automation ─────────────────
    const scriptName = `stress ui schedule ${RUN}`;
    await page.getByTestId('automation-new').click();
    await page.getByTestId('automation-kind-schedule').click();
    await page.getByTestId('automation-page').waitFor();
    await page.getByTestId('when-schedule-preset-daily').click();
    await expect(page.getByTestId('when-next-runs')).not.toContainText('No future run');
    await page.getByTestId('then-choice-run_script').click();
    await page.getByTestId('then-script').fill('/usr/bin/true');
    await page.getByTestId('automation-name').fill(scriptName);
    await shot(page, '02-builder-schedule');
    await page.getByTestId('test-check').click();
    await expect(page.getByTestId('test-check-result')).toBeVisible();
    await page.getByTestId('automation-save').click();
    await expect(page).toHaveURL(/\/dock\/automations\?trigger=/);
    const uiScheduleId = new URL(page.url()).searchParams.get('trigger') as string;
    created.push({ id: uiScheduleId, name: scriptName });
    await expect(page.getByTestId('automation-untested')).toBeVisible();
    await page.getByTestId('test-run-once').click();
    await expect(page.getByTestId('test-run-started')).toBeVisible();
    await expect.poll(async () => (await runsFor(rq, uiScheduleId)).length).toBeGreaterThan(0);
    await page.reload();
    await expect(page.getByTestId('automation-tested')).toBeVisible();
    await page.getByTestId('automation-tab-runs').click();
    await expect(page.locator('[data-testid^="run-row-"]').first()).toBeVisible();
    await shot(page, '03-automation-runs');

    const eventName = `stress ui event ${RUN}`;
    await page.goto('/dock/automations?creating=event');
    await page.getByTestId('automation-page').waitFor();
    await page.getByTestId('when-event-advanced').click();
    await page.getByTestId('when-event-pattern').fill(`st${RUN}.ui.*`);
    await page.getByTestId('then-choice-run_script').click();
    await page.getByTestId('then-script').fill('/usr/bin/true');
    await page.getByTestId('automation-name').fill(eventName);
    await page.getByTestId('automation-save').click();
    await expect(page).toHaveURL(/\/dock\/automations\?trigger=/);
    const uiEventId = new URL(page.url()).searchParams.get('trigger') as string;
    created.push({ id: uiEventId, name: eventName });

    // ── Burst: 300 events across the event automations, 40 at the storm-guarded one ──
    const tags = [
      ...ok.map((_, i) => `st${RUN}.ok${i}.ping`),
      ...failing.map((_, i) => `st${RUN}.fail${i}.ping`),
      `st${RUN}.ui.ping`,
    ];
    const burst: Promise<unknown>[] = [];
    for (let i = 0; i < 260; i++) {
      burst.push(rq.post(`/api/v1/debug/emit_tag`, { data: { tag: tags[i % tags.length], target: `task:${i}`, data: { i } } }));
    }
    for (let i = 0; i < 40; i++) {
      burst.push(rq.post(`/api/v1/debug/emit_tag`, { data: { tag: `st${RUN}.storm.ping`, target: `task:s${i}`, data: {} } }));
    }
    await Promise.all(burst);

    // ── 20 concurrent "Run once now" ─────────────────────────────────────────────────
    const once = await Promise.all(
      Array.from({ length: 20 }, (_, i) => rq.post(`${T}/${ok[i % ok.length].id}/test`, { data: {} })),
    );
    for (const r of once) expect(r.status()).toBe(200);

    // ── Every fire is a run with the right status ────────────────────────────────────
    await expect
      .poll(async () => (await runsFor(rq, ok[0].id, '&include_tests=false')).length, { timeout: 20_000 })
      .toBeGreaterThanOrEqual(Math.floor(260 / tags.length));
    for (const f of failing) {
      await expect.poll(async () => (await runsFor(rq, f.id)).filter((r) => r.status === 'failed').length).toBeGreaterThan(0);
      const failed = (await runsFor(rq, f.id)).find((r) => r.status === 'failed');
      expect(failed?.error).toMatch(/no agent to run/);
    }
    await expect
      .poll(async () => (await runsFor(rq, storm.id)).filter((r) => r.reason_code === 'storm').length)
      .toBeGreaterThan(0);
    const stormRuns = await runsFor(rq, storm.id);
    expect(stormRuns.filter((r) => r.status !== 'skipped').length).toBeLessThanOrEqual(5);
    const okRuns = await runsFor(rq, ok[0].id);
    expect(okRuns.some((r) => r.is_test)).toBe(true);
    expect(okRuns.every((r) => ['succeeded', 'running', 'launched'].includes(r.status))).toBe(true);

    // ── Failures are named up front, and the Runs filter shows them with their error ─
    await page.goto('/dock/automations');
    await expect(page.getByTestId('automations-attention')).toBeVisible();
    await expect(page.getByTestId('automations-nav-failing')).toBeVisible();
    await shot(page, '04-list-with-failures');
    await page.getByTestId('automations-attention').click();
    await expect(page).toHaveURL(/\/dock\/automations\/runs\?status=failed/);
    const firstFailed = page.locator('[data-testid^="run-row-"][data-status="failed"]').first();
    await firstFailed.click();
    await expect(page.getByTestId('run-detail-error')).toContainText('no agent to run');
    await shot(page, '05-run-failed');

    // A skipped run says why in words.
    await page.goto(`/dock/automations/runs?trigger=${storm.id}&status=skipped`);
    await expect(page.locator('[data-testid^="run-row-"]').first()).toContainText('fired too often');

    // ── Rapid switches: off and on, ten rows, twice each ─────────────────────────────
    await page.goto('/dock/automations');
    await page.getByTestId('automations-list').waitFor();
    const flips = [...ok, ...schedules].slice(0, 10);
    for (const round of [0, 1]) {
      for (const a of flips) await page.getByTestId(`automation-toggle-${a.id}`).click();
      const expected = round === 0 ? 'unchecked' : 'checked';
      for (const a of flips) {
        await expect(page.getByTestId(`automation-toggle-${a.id}`)).toHaveAttribute('data-state', expected);
      }
    }
    const overview = (await (await rq.get(`${T}/overview`)).json()).data as Array<{ id: string; enabled: boolean }>;
    for (const a of flips) expect(overview.find((o) => o.id === a.id)?.enabled).toBe(true);

    // ── The event bus lists who listens, and the sandbox answers ─────────────────────
    await page.goto(`/dock/automations/bus?tag=st${RUN}.ok0.ping`);
    await expect(page.getByTestId('bus-flow')).toContainText(ok[0].name);
    await page.getByTestId('bus-sandbox-pattern').fill(`st${RUN}.ok0.*`);
    await page.getByTestId('bus-sandbox-tag').fill(`st${RUN}.ok0.ping`);
    await page.getByTestId('bus-sandbox-test').click();
    await expect(page.getByTestId('bus-sandbox-result')).toHaveAttribute('data-matches', 'true');
    await shot(page, '06-bus');

    // ── Old Events links still land on the automation ────────────────────────────────
    await page.goto(`/dock/events?trigger=${ok[1].id}`);
    await expect(page).toHaveURL(new RegExp(`/dock/automations\\?trigger=${ok[1].id}`));
    await expect(page.getByTestId('automation-page')).toHaveAttribute('data-automation-id', ok[1].id);
    await page.goto('/dock/signals');
    await expect(page).toHaveURL(/\/dock\/automations\/bus/);

    // ── 100 warm navigations across the three places, by clicking (URL-first) ───────
    await page.goto('/dock/automations');
    await page.getByTestId('automations-list').waitFor();
    const steps: Array<[() => Promise<unknown>, string]> = [
      [() => page.getByTestId('automations-nav-runs').click(), 'automations-runs'],
      [() => page.getByTestId('automations-nav-bus').click(), 'automations-bus'],
      [() => page.getByTestId('automations-nav-list').click(), 'automations-list'],
      [() => page.getByTestId(`automation-row-${ok[2].id}`).click(), 'automation-page'],
    ];
    const timings: number[] = [];
    for (let i = 0; i < 100; i++) {
      const [go, id] = steps[i % steps.length];
      timings.push(await timed(page, go, id));
    }
    timings.sort((a, b) => a - b);
    const p50 = timings[50];
    const p95 = timings[95];
    console.log(`[automations-stress] 100 warm navigations: p50 ${p50} ms, p95 ${p95} ms`);
    expect(p95).toBeLessThan(1_500);

    // ── No duplicate rows, nothing thrown, no unexpected error answers ───────────────
    await page.goto('/dock/automations');
    await page.getByTestId('automations-list').waitFor();
    const ids = await page.locator('[data-automation-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-automation-id')));
    expect(new Set(ids).size).toBe(ids.length);
    await shot(page, '07-list-final');
    expect(pageErrors).toEqual([]);
    expect(badResponses).toEqual([]);
  } finally {
    for (const a of created) await rq.delete(`${T}/${a.id}/delete`).catch(() => undefined);
    await rq.dispose();
  }
});
