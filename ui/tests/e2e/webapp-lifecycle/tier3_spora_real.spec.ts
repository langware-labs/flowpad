/**
 * Tier 3 — the REAL Spora project, real secrets (docs/webapp-lifecycle.md). Runs only with WL_TIER3=1, and only
 * after tiers 1 and 2 passed in this report folder (`tiers-1-2.pass`). Never in CI.
 *
 * It indexes the Spora checkout itself (`SPORA_ROOT`) as a project of the test instance — the same folders the
 * person's own Flowpad runs, so a running Admin is adopted as the app's own (its processes live in its folder), not
 * started twice. The tenant is launched the real way (through Admin, with the key Admin reads from gcloud); a
 * secret this machine does not have is said as `needs_person`, never worked around and never handed to an agent.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { Api } from './_api';
import { INSTANCE, instanceOk } from './_instance';
import { record } from './_metrics';
import { openApp, visibleState } from './_page';
import { reportDir } from './_reportdir';

const SPORA = process.env.SPORA_ROOT || join(homedir(), 'Flowpad workspace', 'sapora-streams');
const WATCH = 300_000; // a real flutter build / npm install is measured, not budgeted
let api: Api;
let projectId = '';
const typeids: Record<string, string> = {};

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.skip(process.env.WL_TIER3 !== '1', 'tier 3 runs only with WL_TIER3=1');
  test.skip(!existsSync(join(reportDir(), 'tiers-1-2.pass')) && process.env.WL_TIER3_FORCE !== '1',
    'tier 3 runs only after tiers 1 and 2 passed (tiers-1-2.pass in the report folder)');
  test.skip(!instanceOk(INSTANCE), typeof INSTANCE === 'string' ? INSTANCE : '');
  test.skip(!existsSync(join(SPORA, 'agentic-assets', 'webapp')), `no Spora checkout at ${SPORA}`);
  if (!instanceOk(INSTANCE)) return;
  api = new Api(INSTANCE.apiUrl);
  const found = await api.json('POST', `${api.graph}/project`, { type: 'project', name: 'sapora-streams', fs_storage_mount_path: SPORA });
  projectId = found?.data?.id;
  expect(projectId, JSON.stringify(found).slice(0, 300)).toBeTruthy();
  const q = new URLSearchParams({ path: SPORA });
  await api.json('POST', `${api.graph}/compute_node/@local/fs-records/index?${q}`);
  const apps = await api.json('GET', `${api.graph}/micro_app`);
  for (const row of apps?.data ?? []) {
    if (String(row.asset_ref ?? '').startsWith(join(SPORA, 'agentic-assets', 'webapp'))) typeids[row.name] = `micro_app-${row.id}`;
  }
  expect(Object.keys(typeids).sort(), JSON.stringify(typeids)).toEqual(['spora-admin', 'spora-app', 'spora-backoffice']);
});

for (const app of ['spora-admin', 'spora-backoffice', 'spora-app']) {
  test(`${app}: opens on real Spora — up, or exactly what the person must do; never an agent for a missing secret`, async ({ page }, info) => {
    const t0 = Date.now();
    const agentsBefore = await api.agentAttempts(typeids[app]); // the record keeps earlier runs' attempts
    await openApp(page, typeids[app]);
    const settled = async () => {
      const rec = await api.lifecycle(typeids[app]);
      return ['up', 'degraded', 'needs_person', 'failed'].includes(rec?.state) || /waiting|answer|sign in|credential/i.test(rec?.detail ?? '');
    };
    await expect.poll(settled, { timeout: WATCH, intervals: [2000] }).toBe(true);
    const rec = await api.lifecycle(typeids[app]);
    // A real app has no stub marker: it is ready when its frame renders something.
    const ready = rec?.state === 'up'
      ? await expect.poll(async () => (await page.frameLocator('[data-testid="vibe-app-frame"]').first().locator('body')
          .innerText({ timeout: 2000 }).catch(() => '')).trim().length, { timeout: 60_000 }).toBeGreaterThan(0)
          .then(() => Date.now() - t0).catch(() => null)
      : null;
    record(info, { app, scenario: 'T3', timings: { settled: Date.now() - t0, ready },
      agentRuns: (await api.agentAttempts(typeids[app])) - agentsBefore,
      notes: [`record ${rec?.state}: ${rec?.detail}`, `owed: ${rec?.setup_owed ?? ''}`, `shows: ${ready === null ? await visibleState(page) : 'ready'}`] });
    if (rec?.state === 'up') {
      expect(ready, `${app} is up but its page never rendered`).not.toBeNull();
    } else {
      // Not up: it must say what the person must do, and no agent may have been spent on it.
      expect(`${rec?.detail} ${rec?.setup_owed}`.trim().length).toBeGreaterThan(0);
    }
    expect((await api.agentAttempts(typeids[app])) - agentsBefore, 'no agent for what only the person can give').toBe(0);
  });
}
