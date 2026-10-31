/**
 * Tier 1 — python-only stub apps, the scenario matrix S1–S8 (docs/webapp-lifecycle.md, plan "Validation suite").
 *
 * Each scenario asserts on the app's lifecycle record (`micro_app/<id>/lifecycle`): the states it went through, the
 * recovery attempts per failure fingerprint (the fixer policy: deterministic fixes cost no agent, an unknown failure
 * gets the agent once), and the plan's budgets: a warm return asks the backend nothing and shows the frame within
 * 200 ms; a reopen after a backend restart is up within 2 s.
 *
 * Sampling windows below bound how long a scenario WATCHES; the budgets are the assertions. Never raise either to
 * make a row go green — a slow open is the bug.
 */
import { rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { Api, sampleStates, type App, type Seeded } from './_api';
import { INSTANCE, instanceOk } from './_instance';
import { occupyPort, release, sigkill } from './_inject';
import { record } from './_metrics';
import { countBackendCalls, frame, openApp, READY, timeToReady, visibleState } from './_page';

const WATCH = 60_000; // how long a cold open / a recovery is watched
const WARM_FRAME_MS = 200; // B12: warm return to a visible frame
const RESTART_OPEN_MS = 2_000; // B12: cold open of a running server
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

let api: Api;
let project: Seeded;
const apps: Record<string, App> = {};

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.skip(!instanceOk(INSTANCE), typeof INSTANCE === 'string' ? INSTANCE : '');
  if (!instanceOk(INSTANCE)) return;
  api = new Api(INSTANCE.apiUrl);
  test.skip(!(await api.healthy()), `backend not up on ${INSTANCE.apiUrl}`);
  project = await api.seedProject(`wl-t1-${Date.now()}`);
  for (const f of ['static-ok', 'dev-ok', 'service-stub', 'needs-service', 'page-errors']) {
    apps[f] = await api.indexApp(project, f);
  }
});

test.afterAll(async () => {
  if (!api || !project) return;
  await api.json('POST', `${api.graph}/project/${project.id}/app-stop`).catch(() => undefined);
});

const stateOf = (app: App) => async () => (await api.lifecycle(app.typeid)) ?? null;

/** Open `app` and watch it: time to the stub's ready marker, the record's states meanwhile. */
async function open(page: Page, app: App) {
  const agentsBefore = await api.agentAttempts(app.typeid);
  const t0 = Date.now();
  await openApp(page, app.typeid);
  let readyMs: number | null = null;
  const readyP = timeToReady(page, WATCH).then((ms) => (readyMs = ms === null ? null : Date.now() - t0));
  const transitions = await sampleStates(stateOf(app), WATCH, () => readyMs !== null).catch(() => [] as string[]);
  await readyP;
  return {
    readyMs,
    transitions,
    shows: readyMs === null ? await visibleState(page) : 'ready',
    agents: (await api.agentAttempts(app.typeid)) - agentsBefore,
    rec: await api.lifecycle(app.typeid),
  };
}

for (const name of ['static-ok', 'dev-ok']) {
  test(`S1 ${name}: cold open → usable, no agent`, async ({ page }, info) => {
    const r = await open(page, apps[name]);
    record(info, { app: name, scenario: 'S1', timings: { ready: r.readyMs }, transitions: r.transitions,
      agentRuns: r.agents, notes: [`shows: ${r.shows}`, `record: ${r.rec?.state} ${r.rec?.detail ?? ''}`] });
    expect(r.readyMs, `${name} never showed stub-ready (shows: ${r.shows})`).not.toBeNull();
    expect(r.rec?.state).toBe('up');
    expect(r.agents).toBe(0);
  });
}

test('S2 dev-ok: warm return asks the backend nothing and shows the frame at once', async ({ page }, info) => {
  const app = apps['dev-ok'];
  await openApp(page, app.typeid);
  expect(await timeToReady(page, WATCH)).not.toBeNull();
  await page.getByTestId('top-nav-home').click();
  await expect(page).not.toHaveURL(/\/dock\/app\//);
  const calls = countBackendCalls(page);
  calls.reset();
  const t0 = Date.now();
  await page.goBack();
  const ready = await timeToReady(page, WATCH);
  const warmMs = ready === null ? null : Date.now() - t0;
  await page.waitForTimeout(1000); // trailing calls of the return land in the count
  calls.stop();
  const appCalls = calls.urls.filter((u) => !/\/activate$|\/bootstrap|\/watch/.test(u));
  record(info, { app: 'dev-ok', scenario: 'S2', timings: { warmFrame: warmMs }, backendCalls: appCalls.length,
    backendCallUrls: calls.urls });
  expect(warmMs).not.toBeNull();
  expect(warmMs!).toBeLessThan(WARM_FRAME_MS);
  expect(appCalls, 'a warm return asks the backend nothing about the app').toEqual([]);
});

test('S3 dev-ok: backend restart → the record stays up, a reopen is up at once, no agent', async ({ page }, info) => {
  const app = apps['dev-ok'];
  const before = await api.lifecycle(app.typeid);
  expect(before?.state).toBe('up');
  execFileSync(join(REPO, 'scripts', 'instance_ctl.sh'), ['restart-backend', INSTANCE && typeof INSTANCE !== 'string' ? INSTANCE.name : ''],
    { stdio: 'inherit' });
  const after = await api.lifecycle(app.typeid);
  const r = await open(page, app);
  record(info, { app: 'dev-ok', scenario: 'S3', timings: { reopen: r.readyMs }, transitions: r.transitions,
    agentRuns: r.agents, notes: [`before ${before?.state} pids ${JSON.stringify(before?.pids)}`, `after restart ${after?.state}`] });
  expect(after?.state, 'a restart redoes nothing: the record reads back up').toBe('up');
  expect(r.readyMs).not.toBeNull();
  expect(r.readyMs!).toBeLessThan(RESTART_OPEN_MS);
  expect(r.transitions.every((s) => s === 'up'), `no transition: ${r.transitions}`).toBe(true);
  expect(r.agents).toBe(0);
});

test('S4 dev-ok: dev server SIGKILL → restarted by code, no agent', async ({ page }, info) => {
  const app = apps['dev-ok'];
  await openApp(page, app.typeid);
  expect(await timeToReady(page, WATCH)).not.toBeNull();
  const pid = await api.pagePid(project.id, 'dev-ok');
  const agentsBefore = await api.agentAttempts(app.typeid);
  expect(pid && sigkill(pid), 'had a pid to kill').toBeTruthy();
  const t0 = Date.now();
  await page.reload();
  const ready = await timeToReady(page, WATCH);
  const recoveredMs = ready === null ? null : Date.now() - t0;
  const rec = await api.lifecycle(app.typeid);
  const newPid = await api.pagePid(project.id, 'dev-ok');
  record(info, { app: 'dev-ok', scenario: 'S4', timings: { recovered: recoveredMs },
    notes: [`pid ${pid} → ${newPid}`, `record ${rec?.state}`, `shows: ${ready === null ? await visibleState(page) : 'ready'}`] });
  expect(recoveredMs, 'the app came back after SIGKILL').not.toBeNull();
  expect(newPid).not.toBe(pid);
  expect(rec?.state).toBe('up');
  expect((await api.agentAttempts(app.typeid)) - agentsBefore, 'no agent for a dead dev server').toBe(0);
});

test('S5 needs-service: its dependency is a setup node — started first, restarted when killed, no agent', async ({ page }, info) => {
  const app = apps['needs-service'];
  const r = await open(page, app);
  const stub = (await api.appPorts(project.id, 'service-stub')).find((p) => p.process === 'tenant');
  expect(r.readyMs, `needs-service never ready (shows: ${r.shows}; record ${r.rec?.state}: ${r.rec?.detail})`).not.toBeNull();
  expect(stub?.port, 'the dependency node started service-stub\'s tenant').toBe(48300);
  // Kill the dependency under the open page: its error is handled by `setup asset_setup:needs-tenant`, by code.
  expect(stub?.pid && sigkill(stub.pid)).toBeTruthy();
  const t0 = Date.now();
  await page.reload();
  const ready = await timeToReady(page, WATCH);
  const back = (await api.appPorts(project.id, 'service-stub')).find((p) => p.process === 'tenant');
  record(info, { app: 'needs-service', scenario: 'S5', timings: { firstReady: r.readyMs, recovered: ready === null ? null : Date.now() - t0 },
    transitions: r.transitions, agentRuns: await api.agentAttempts(app.typeid),
    notes: [`tenant pid ${stub?.pid} → ${back?.pid}`, `record ${(await api.lifecycle(app.typeid))?.state}`] });
  expect(ready, 'needs-service came back after its dependency was killed').not.toBeNull();
  expect(back?.pid).not.toBe(stub?.pid);
  expect(await api.agentAttempts(app.typeid)).toBe(0);
});

test('S6 page-errors: a known page error is handled by its handling, no agent', async ({ page }, info) => {
  const app = apps['page-errors'];
  writeFileSync(join(app.dir, 'public', 'mode.txt'), 'known');
  const r = await open(page, app);
  await page.waitForTimeout(3000); // the report after the page settles
  const rec = await api.lifecycle(app.typeid);
  record(info, { app: 'page-errors', scenario: 'S6', timings: { ready: r.readyMs }, transitions: r.transitions,
    agentRuns: await api.agentAttempts(app.typeid), notes: [`record ${rec?.state}`] });
  expect(await frame(page).locator(READY).first().isVisible()).toBe(true);
  expect(rec?.state).toBe('up');
  expect(await api.agentAttempts(app.typeid)).toBe(0);
});

test('S7 page-errors: an unknown error gets the fixer exactly once across reloads in the cooldown', async ({ page }, info) => {
  const app = apps['page-errors'];
  const stamp = `${Date.now()}`;
  writeFileSync(join(app.dir, 'public', 'mode.txt'), `unknown-${stamp}`);
  await openApp(page, app.typeid);
  await timeToReady(page, WATCH);
  const settled = async () => {
    const rec = await api.lifecycle(app.typeid);
    return rec && !['recovering', 'installing', 'building', 'starting'].includes(rec.state);
  };
  const first = await sampleStates(stateOf(app), WATCH * 3, settled, 1000);
  await page.reload();
  await timeToReady(page, WATCH);
  const second = await sampleStates(stateOf(app), WATCH * 3, settled, 1000);
  const rec = await api.lifecycle(app.typeid);
  const fp = rec?.failure?.fingerprint ?? '';
  record(info, { app: 'page-errors', scenario: 'S7', transitions: [...first, '| reload |', ...second],
    agentRuns: await api.agentAttempts(app.typeid), notes: [`record ${rec?.state}: ${rec?.detail}`, `fingerprint ${fp}`] });
  const counter = (rec?.attempts ?? []).find((a: any) => a.agent > 0);
  expect(counter?.agent, 'the fixer ran exactly once for this fingerprint').toBe(1);
  writeFileSync(join(app.dir, 'public', 'mode.txt'), '');
});

test('S8 dev-ok: its port taken and its install gone → fixed by code, no agent', async ({ page }, info) => {
  const app = apps['dev-ok'];
  await api.json('POST', `${api.graph}/project/${project.id}/app-stop`, { app: 'dev-ok' });
  const squatter = await occupyPort(48101); // a non-required port: the app moves
  rmSync(join(app.dir, '.installed'), { recursive: true, force: true });
  try {
    const r = await open(page, app);
    const row = (await api.appPorts(project.id, 'dev-ok')).find((p) => p.process === 'page');
    record(info, { app: 'dev-ok', scenario: 'S8', timings: { ready: r.readyMs }, transitions: r.transitions,
      agentRuns: r.agents, notes: [`now on ${row?.port}`] });
    expect(r.readyMs, `shows: ${r.shows}`).not.toBeNull();
    expect(row?.port).not.toBe(48101);
    expect(r.transitions).toContain('installing');
    expect(r.agents).toBe(0);
  } finally {
    release(squatter);
  }
});
