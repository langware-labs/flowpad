/**
 * Tier 2 — Spora's own app declarations in a fresh project, with a STUB tenant (docs/webapp-lifecycle.md).
 *
 * What is Spora's is copied as it is from the Spora checkout (`SPORA_ROOT`, default ~/Flowpad workspace/sapora-streams):
 * the three web apps' `webapp.json`, their declared setup nodes (`asset_setup`), learned handlings, the wizards and ops
 * those nodes run, and the google-cloud credential Admin needs. Two things stand in:
 *   - a small bundle for `app/frontend/build/web` that bootstraps from :8300 like the Flutter build and throws the same
 *     empty `Uncaught` when the tenant is down;
 *   - the `spora-tenant-launch` op body starts a stub tenant on :8300 instead of launching the real one through Admin
 *     (same node, same completion check). Tier 3 runs the real one.
 * No secret is needed here.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { Api, FIXTURES, type Seeded } from './_api';
import { INSTANCE, instanceOk } from './_instance';
import { freeFixturePorts, sigkill } from './_inject';
import { record } from './_metrics';
import { openApp, timeToReady, visibleState } from './_page';

const SPORA = process.env.SPORA_ROOT || join(homedir(), 'Flowpad workspace', 'sapora-streams');
const WATCH = 90_000;
const STUB = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'spora', 'stub_tenant.py');

let api: Api;
let project: Seeded;
const typeids: Record<string, string> = {};

test.describe.configure({ mode: 'serial' });

/** Copy a folder, leaving out what is generated or this machine's. */
function copy(from: string, to: string): void {
  cpSync(from, to, {
    recursive: true,
    filter: (src) => !/(\/node_modules|\/setup\/logs|\.log$|\/rca_log\.md$|\/\.flow\/)/.test(src),
  });
}

async function index(type: string, path: string): Promise<string> {
  const q = new URLSearchParams({ type, path });
  const r = await api.json('POST', `${api.graph}/compute_node/@local/fs-records/index?${q}`);
  return String(r?.data?.typeid ?? r?.typeid ?? '');
}

test.beforeAll(async () => {
  test.skip(!instanceOk(INSTANCE), typeof INSTANCE === 'string' ? INSTANCE : '');
  test.skip(!existsSync(join(SPORA, 'agentic-assets', 'webapp', 'spora-app')), `no Spora checkout at ${SPORA}`);
  if (!instanceOk(INSTANCE)) return;
  api = new Api(INSTANCE.apiUrl);
  freeFixturePorts([8300]); // a stub tenant a crashed earlier run left listening
  project = await api.seedProject(`wl-t2-spora-${Date.now()}`);
  const assets = join(project.root, 'agentic-assets');
  for (const family of ['wizard', 'compute_op']) {
    for (const name of readdirSync(join(SPORA, 'agentic-assets', family))) {
      if (!name.startsWith('spora-')) continue;
      copy(join(SPORA, 'agentic-assets', family, name), join(assets, family, name));
    }
  }
  copy(join(SPORA, 'agentic-assets', 'credential', 'google-cloud'), join(assets, 'credential', 'google-cloud'));
  for (const app of ['spora-app', 'spora-backoffice', 'spora-admin']) {
    copy(join(SPORA, 'agentic-assets', 'webapp', app), join(assets, 'webapp', app));
  }
  // The stand-ins. The stub tenant needs no Admin to launch it: the node under the tenant that starts Admin's API
  // (for the real launch) is not part of tier 2 — tier 3 runs it.
  rmSync(join(assets, 'webapp', 'spora-app', 'agentic-assets', 'asset_setup', 'spora-admin-api'), { recursive: true, force: true });
  writeFileSync(join(assets, 'compute_op', 'spora-tenant-launch', 'compute_op.json'),
    readFileSync(join(FIXTURES, 'spora', 'spora-tenant-launch.compute_op.json'), 'utf8').replaceAll('__STUB__', STUB));
  mkdirSync(join(project.root, 'app', 'frontend', 'build'), { recursive: true });
  copy(join(FIXTURES, 'spora', 'app-frontend-build-web'), join(project.root, 'app', 'frontend', 'build', 'web'));
  copy(join(FIXTURES, 'spora', 'app-admin-public'), join(project.root, 'app', 'admin', 'public'));

  for (const family of ['wizard', 'compute_op']) {
    for (const name of readdirSync(join(assets, family))) await index(family, join(assets, family, name));
  }
  await index('credential', join(assets, 'credential', 'google-cloud'));
  for (const app of ['spora-app', 'spora-backoffice', 'spora-admin']) {
    typeids[app] = await index('micro_app', join(assets, 'webapp', app));
    const setups = join(assets, 'webapp', app, 'agentic-assets', 'asset_setup');
    if (existsSync(setups)) for (const n of readdirSync(setups)) await index('asset_setup', join(setups, n));
  }
  expect(Object.values(typeids).every((t) => /^micro_app-/.test(t)), JSON.stringify(typeids)).toBe(true);
});

test.afterAll(async () => {
  if (!api || !project) return;
  await api.json('POST', `${api.graph}/project/${project.id}/app-stop`).catch(() => undefined);
  freeFixturePorts([8300]); // the stub tenant is no app's process: nothing else stops it, and a real app must never
  // bootstrap from it afterwards (tier 3 found exactly that)
});

const tenant = async () => (await api.appPorts(project.id)).length >= 0 && fetch('http://127.0.0.1:8300/api/bootstrap')
  .then((r) => r.ok).catch(() => false);

test('Spora App: its tenant is a setup node — launched first, then the app; no agent', async ({ page }, info) => {
  const t0 = Date.now();
  await openApp(page, typeids['spora-app']);
  const ready = await timeToReady(page, WATCH);
  const rec = await api.lifecycle(typeids['spora-app']);
  record(info, { app: 'spora-app', scenario: 'T2-S1', timings: { ready: ready === null ? null : Date.now() - t0 },
    agentRuns: await api.agentAttempts(typeids['spora-app']), notes: [`record ${rec?.state}: ${rec?.detail}`,
      `shows ${ready === null ? await visibleState(page) : 'ready'}`] });
  expect(ready, `Spora App never ready (record ${rec?.state}: ${rec?.detail})`).not.toBeNull();
  expect(await tenant(), 'the tenant node launched the (stub) tenant on :8300').toBe(true);
  expect(await api.agentAttempts(typeids['spora-app'])).toBe(0);
});

test('Spora App: the tenant dies under the open app → its learned handling relaunches it; no agent', async ({ page }, info) => {
  await openApp(page, typeids['spora-app']);
  expect(await timeToReady(page, WATCH)).not.toBeNull();
  const holder = (await import('node:child_process')).execFileSync('lsof', ['-tiTCP:8300', '-sTCP:LISTEN']).toString().trim();
  expect(holder && sigkill(Number(holder.split('\n')[0]))).toBeTruthy();
  const t0 = Date.now();
  await page.reload();
  const ready = await timeToReady(page, WATCH);
  const rec = await api.lifecycle(typeids['spora-app']);
  record(info, { app: 'spora-app', scenario: 'T2-S5', timings: { recovered: ready === null ? null : Date.now() - t0 },
    agentRuns: await api.agentAttempts(typeids['spora-app']), notes: [`record ${rec?.state}: ${rec?.detail}`] });
  expect(ready, `Spora App did not come back (record ${rec?.state}: ${rec?.detail})`).not.toBeNull();
  expect(await tenant()).toBe(true);
  expect(await api.agentAttempts(typeids['spora-app']), 'the learned handling, not an agent').toBe(0);
});

test('Spora Back Office: comes up, warm return asks nothing; no agent', async ({ page }, info) => {
  const r0 = Date.now();
  await openApp(page, typeids['spora-backoffice']);
  const ready = await timeToReady(page, WATCH);
  const rec = await api.lifecycle(typeids['spora-backoffice']);
  record(info, { app: 'spora-backoffice', scenario: 'T2-S1', timings: { ready: ready === null ? null : Date.now() - r0 },
    notes: [`record ${rec?.state}: ${rec?.detail}`] });
  expect(ready, `Back Office never ready (record ${rec?.state}: ${rec?.detail})`).not.toBeNull();
  expect(await api.agentAttempts(typeids['spora-backoffice'])).toBe(0);
});

test('Spora Admin: what it owes (the google-cloud credential) is asked of the person, never an agent', async ({ page }, info) => {
  await openApp(page, typeids['spora-admin']);
  const owes = async () => {
    const rec = await api.lifecycle(typeids['spora-admin']);
    return `${rec?.state}|${rec?.setup_owed}|${rec?.detail}`;
  };
  await expect.poll(owes, { timeout: WATCH }).toMatch(/google|credential|needs_person|setting up/i);
  const rec = await api.lifecycle(typeids['spora-admin']);
  record(info, { app: 'spora-admin', scenario: 'T2-owed', notes: [`record ${rec?.state}: ${rec?.detail} | owed ${rec?.setup_owed}`] });
  expect(await api.agentAttempts(typeids['spora-admin'])).toBe(0);
});
