/**
 * Tier 1 — python-only stub apps, scenario matrix S1–S8 (plan "Validation suite").
 *
 * PHASE 0 = characterization against TODAY's code: S1, S2, S4, S6 run and RECORD what happens
 * (timings, load-record transitions, fixer/agent run counts, backend-call counts) into the report.
 * Outcomes are soft-asserted so a red row shows the baseline without stopping the measurement;
 * S2's call count is recorded, not asserted to be 0. S3/S5/S7/S8 are `test.fixme` until the phase
 * that enables them lands.
 *
 * Budgets below bound SAMPLING (how long we watch), they are not raised timeouts — never raise them
 * to make a row go green; a slow open is the bug.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { Api, sampleStates, type App, type Seeded } from './_api';
import { INSTANCE, instanceOk } from './_instance';
import { sigkill } from './_inject';
import { record } from './_metrics';
import { countBackendCalls, frame, openApp, READY, timeToReady, visibleState } from './_page';

const READY_BUDGET = 60_000; // S1/S4 cold open sampling window
const QUIET_WINDOW = 15_000; // how long S6 watches for an agent after a handled error

let api: Api;
let project: Seeded;
const apps: Record<string, App> = {};

// Not serial: in phase 0 a red row must not stop the rows after it from being measured.

test.beforeAll(async () => {
  test.skip(!instanceOk(INSTANCE), typeof INSTANCE === 'string' ? INSTANCE : '');
  if (!instanceOk(INSTANCE)) return;
  api = new Api(INSTANCE.apiUrl);
  test.skip(!(await api.healthy()), `backend not up on ${INSTANCE.apiUrl}`);
  project = await api.seedProject(`wl-t1-${Date.now()}`);
  for (const f of ['static-ok', 'dev-ok', 'service-stub', 'needs-service', 'page-errors']) {
    apps[f] = await api.indexApp(project, f);
  }
  // needs-tenant points at the app that needs the service (filled now that it has an id).
  api.patchJson(join(project.root, 'agentic-assets', 'asset_setup', 'needs-tenant', 'asset_setup.json'), (d) => {
    d.inputs.webapp = apps['needs-service'].typeid;
  });
});

test.afterAll(async () => {
  if (!api || !project) return;
  // Stop what the suite started; the project folder stays in the instance (killed with it).
  await api.json('POST', `${api.graph}/project/${project.id}/app-stop`).catch(() => undefined);
});

/** Open `app` cold and measure: time to the stub's ready marker + the load-record states seen meanwhile. */
async function coldOpen(page: Page, app: App) {
  const fixerBefore = (await api.fixerRuns(project.id)).length;
  const agentsBefore = (await api.allRuns(project.id)).length;
  const t0 = Date.now();
  await openApp(page, app.typeid);
  let readyMs: number | null = null;
  const readyP = timeToReady(page, READY_BUDGET).then((ms) => (readyMs = ms === null ? null : Date.now() - t0));
  const transitions = await sampleStates(
    () => api.loadState(project.id, app.typeid),
    READY_BUDGET,
    () => readyMs !== null,
  ).catch(() => [] as string[]);
  await readyP;
  return {
    readyMs,
    transitions,
    shows: readyMs === null ? await visibleState(page) : 'ready',
    fixerRuns: (await api.fixerRuns(project.id)).length - fixerBefore,
    agentRuns: (await api.allRuns(project.id)).length - agentsBefore,
  };
}

for (const name of ['static-ok', 'dev-ok']) {
  test(`S1 ${name}: cold open → usable`, async ({ page }, info) => {
    const r = await coldOpen(page, apps[name]);
    record(info, {
      app: name,
      scenario: 'S1',
      timings: { ready: r.readyMs },
      transitions: r.transitions,
      fixerRuns: r.fixerRuns,
      agentRuns: r.agentRuns,
      notes: [`shows: ${r.shows}`],
      ports: await api.appPorts(project.id, name),
    });
    expect.soft(r.readyMs, `${name} never showed stub-ready (shows: ${r.shows})`).not.toBeNull();
    expect.soft(r.fixerRuns, 'no fixer on a healthy app').toBe(0);
  });
}

test('S2 dev-ok: warm return — backend calls + frame time (recorded, not asserted)', async ({ page }, info) => {
  const app = apps['dev-ok'];
  await openApp(page, app.typeid);
  const cold = await timeToReady(page, READY_BUDGET);
  const notes = [`cold ready: ${cold}`];
  // Step off in-app (Home), then back: same document, popstate — a WARM return.
  await page.getByTestId('top-nav-home').click();
  await expect(page).not.toHaveURL(/\/dock\/app\//);
  const calls = countBackendCalls(page);
  calls.reset();
  const t0 = Date.now();
  await page.goBack();
  const ready = await timeToReady(page, READY_BUDGET);
  const warmMs = ready === null ? null : Date.now() - t0;
  await page.waitForTimeout(1000); // let trailing calls of the return land in the count
  calls.stop();
  record(info, {
    app: 'dev-ok',
    scenario: 'S2',
    timings: { cold, warmFrame: warmMs },
    backendCalls: calls.count,
    backendCallUrls: calls.urls,
    notes: [...notes, 'plan target: 0 calls, frame < 200 ms (asserted from phase 7/8)'],
  });
  expect.soft(warmMs, 'warm return never showed the app').not.toBeNull();
});

test.fixme('S3 dev-ok: backend restart → still UP, no transition (enabled in phase 5: re-adopt on restart)', async () => {
  // scripts/instance_ctl.sh restart-backend $WL_INSTANCE; record must stay UP, frame untouched, 0 agents.
});

test('S4 dev-ok: dev server SIGKILL → recovers, 0 agents', async ({ page }, info) => {
  const app = apps['dev-ok'];
  await openApp(page, app.typeid);
  await timeToReady(page, READY_BUDGET);
  const pid = await api.pagePid(project.id, 'dev-ok');
  const fixerBefore = (await api.fixerRuns(project.id)).length;
  const agentsBefore = (await api.allRuns(project.id)).length;
  const killed = pid ? sigkill(pid) : false;
  const t0 = Date.now();
  // What the record does by itself after the kill (no reload) …
  const passive = await sampleStates(() => api.loadState(project.id, app.typeid), 10_000, () => false, 500);
  // … then what a reopen does.
  await page.reload();
  const ready = await timeToReady(page, READY_BUDGET);
  const recoveredMs = ready === null ? null : Date.now() - t0;
  const after = await sampleStates(() => api.loadState(project.id, app.typeid), 3000, () => false, 500);
  const newPid = await api.pagePid(project.id, 'dev-ok');
  const fixerRuns = (await api.fixerRuns(project.id)).length - fixerBefore;
  const agentRuns = (await api.allRuns(project.id)).length - agentsBefore;
  record(info, {
    app: 'dev-ok',
    scenario: 'S4',
    timings: { recoveredAfterKill: recoveredMs, reloadToReady: ready },
    transitions: [...passive, '| reload |', ...after],
    fixerRuns,
    agentRuns,
    notes: [`pid ${pid} killed=${killed} → new pid ${newPid}`, `shows: ${ready === null ? await visibleState(page) : 'ready'}`,
      'plan target: up→degraded→starting→up, 0 agents'],
  });
  expect.soft(killed, 'had a pid to kill').toBe(true);
  expect.soft(recoveredMs, 'app came back after SIGKILL').not.toBeNull();
  expect.soft(fixerRuns, 'no fixer for a dead dev server').toBe(0);
});

test.fixme('S5 needs-service: dependency killed → asset_setup node shown, setup ran, UP, 0 agents (phase 9: dependency nodes, webapp-service-up)', async () => {
  // open needs-service with service-stub's tenant down; expect the needs-tenant node, setup(<node>) ran, page ready.
});

test('S6 page-errors: known page error → handled, 0 agents', async ({ page }, info) => {
  const app = apps['page-errors'];
  writeFileSync(join(app.dir, 'public', 'mode.txt'), 'known');
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const r = await coldOpen(page, app);
  // Watch for an agent the handled error should NOT start.
  await page.waitForTimeout(QUIET_WINDOW);
  const fixerRuns = (await api.fixerRuns(project.id)).length;
  const agentRuns = (await api.allRuns(project.id)).length;
  const errorsFile = await api.json('GET', `${api.graph}/project/${project.id}/load-state?asset=${app.typeid}`);
  record(info, {
    app: 'page-errors',
    scenario: 'S6',
    timings: { ready: r.readyMs },
    transitions: r.transitions,
    fixerRuns,
    agentRuns,
    notes: [`shows: ${await visibleState(page)}`, `final record: ${JSON.stringify(errorsFile?.data ?? null).slice(0, 300)}`,
      `top-level page errors: ${pageErrors.length}`],
  });
  expect.soft(await frame(page).locator(READY).first().isVisible().catch(() => false), 'app shown despite the known error').toBe(true);
  expect.soft(fixerRuns, 'no fixer for a known (ignored) error').toBe(0);
});

test.fixme('S7 page-errors: unknown error → exactly 1 agent across two reloads in the cooldown, then a handling (phase 4: coordinator + cooldown; phase 2: webapp_handlings.json)', async () => {
  // mode.txt = unknown-<stamp>; reload twice; fixerRuns === 1; then the fingerprint is in webapp_handlings.json.
});

test.fixme('S8 dev-ok: port occupied / install corrupted → rung ran, 0 agents (phase 4 ladder + phase 5 install stamps)', async () => {
  // occupyPort(48101) (non-required → another port); truncateInstallMarker(dir) → install reruns; 0 agents.
});
