/**
 * One-click install, end to end, in one process:
 *
 *   hub-mode SDK realm  ──requestInstall(typeid)──▶  hub `project/<id>/install`
 *        ▲                                                  │ hub WS → dev-1 backend (client_type=desktop)
 *        │                                                  ▼
 *   dev-1 SDK realm  ◀── local WS `ui_command install_request` ── hub_bridge
 *        │  (this is what opens the Add-asset dialog in a browser)
 *        └──installPublished(request)──▶ dev-1 copies from the row's origin,
 *           indexes with the publisher's id, records deps.json.
 *
 * Both projects live on dev-1 (a `LocalOrigin` is same-machine by design).
 * Requires the local hub + `scripts/instance_ctl.sh launch dev-1` (+ dev-2 for
 * the rig contract). Skips otherwise.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSdkRealm, type OwnedSdkRealm } from '../_sdk_realm';
import { testEntityName } from '../_cleanup';
import { HUB_URL, getAliceCreds, hubAvailable, hubJson, hubLogin, localBackendIsCloudLoggedIn } from './_hub';
import { HUB_INST_1 as INST_1, WORKTREE_ROOT, getInstance, instanceAvailable, jsonApi, postApi, type ResolvedInstance } from './_instances';

let skipReason: string | null = null;
let dev1: ResolvedInstance;
let hub: OwnedSdkRealm;
let token = '';
let sourceId = '';
let targetId = '';
let sourceRoot = '';
let targetRoot = '';
let cliRoot = '';
let cliTargetId = '';
let skillId = '';
const skillName = testEntityName('skill').replace(/[^a-z0-9-]/gi, '-').toLowerCase();

beforeAll(async () => {
  const h = await hubAvailable();
  if (!h.ok) return void (skipReason = h.reason ?? 'hub unreachable');
  if (!instanceAvailable(INST_1)) return void (skipReason = `launch ${INST_1} via scripts/instance_ctl.sh`);
  dev1 = await getInstance(INST_1);
  if (!(await localBackendIsCloudLoggedIn(`${dev1.apiUrl}/api/v1`))) return void (skipReason = `${INST_1} is not cloud-logged-in`);
  const alice = await getAliceCreds();
  if (!alice) return void (skipReason = 'no ALICE creds');
  token = (await hubLogin(alice.email, alice.password)).token;

  // Two git-less projects in the workspace (the only place a mount is scanned).
  const ws = path.join(homedir(), 'Flowpad workspace');
  sourceRoot = path.join(ws, testEntityName('pubsrc'));
  targetRoot = path.join(ws, testEntityName('pubdst'));
  cliRoot = path.join(ws, testEntityName('pubcli'));
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(targetRoot, { recursive: true });
  mkdirSync(cliRoot, { recursive: true });
  const src = await postApi(dev1.apiUrl, '/graph/project', { type: 'project', name: path.basename(sourceRoot), fs_storage_mount_path: sourceRoot });
  const dst = await postApi(dev1.apiUrl, '/graph/project', { type: 'project', name: path.basename(targetRoot), fs_storage_mount_path: targetRoot });
  sourceId = src.data.id;
  targetId = dst.data.id;
  // The hub row the desk reflects into — created BEFORE publishing.
  await hubJson(token, '/graph/project', { type: 'project', id: sourceId, name: path.basename(sourceRoot) });

  // A skill in the source project, created through the desk so it is indexed
  // at its placement (`<source>/.claude/skills/<name>/SKILL.md`).
  const skill = await dev1.sdk.Skill.createInProject({ typeId: new dev1.sdk.TypeId('project', sourceId) }, skillName);
  skillId = skill.id;
  if (!skillId) throw new Error('skill create failed');
  const pub = await postApi(dev1.apiUrl, `/graph/skill/${skillId}/set-published`, { published: true, project_id: sourceId });
  if (pub.status !== 'SUCCESS') throw new Error(`publish failed: ${JSON.stringify(pub).slice(0, 200)}`);

  // A hub-mode SDK realm, logged in as the same user.
  hub = await createSdkRealm(HUB_URL);
  hub.sdk.setSupportedPagesForHubMode(['hub']);
  (hub.sdk.apiClient as unknown as { testUserToken?: string }).testUserToken = token;
}, 30_000);

beforeEach((context: any) => {
  if (skipReason) {
    console.warn(`[install_from_hub] skipped: ${skipReason}`);
    context.skip();
  }
});

afterAll(async () => {
  try {
    if (token && sourceId) await hubJson(token, `/graph/project/${sourceId}`, undefined, 'DELETE').catch(() => undefined);
    if (dev1 && sourceId) await jsonApi(dev1.apiUrl, `/graph/project/${sourceId}`, 'DELETE');
    if (dev1 && targetId) await jsonApi(dev1.apiUrl, `/graph/project/${targetId}`, 'DELETE');
    if (dev1 && cliTargetId) await jsonApi(dev1.apiUrl, `/graph/project/${cliTargetId}`, 'DELETE');
  } finally {
    for (const p of [sourceRoot, targetRoot, cliRoot]) if (p && existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
});

describe('one-click install: hub → desktop → browser SDK → install', () => {
  it('the hub relays the row to the logged-in desktop, which pops it to the client; the client installs it', async () => {
    const typeid = `skill-${skillId}`;

    // The hub has the row (the desk reflects the manifest in the background
    // right after the publish), with WHERE its bytes are.
    let row: any;
    while (!row) {
      const view = await hubJson(token, `/graph/project/${sourceId}/published`);
      row = view.rows.find((r: { typeid: string }) => r.typeid === typeid);
      if (!row) await new Promise((r) => setTimeout(r, 200));
    }
    expect(row.origin?.kind).toBe('local');

    // The popup trigger: dev-1's client SDK receives the ui_command the desk
    // backend broadcast after the hub pushed install_request over its socket.
    const cm = dev1.sdk.connectionManager;
    const got = new Promise<any>((resolve) => {
      const handler = (m: any) => {
        if (m?.kind === 'install_request' && m.request?.typeid === typeid) {
          cm.off('on_ui_command', handler);
          resolve(m.request);
        }
      };
      cm.on('on_ui_command', handler);
    });

    const sent = await new hub.sdk.Project({ id: sourceId, type: 'project' }).requestInstall(typeid);
    expect(sent.delivered).toBeGreaterThanOrEqual(1);
    expect(sent.request_id).toBeTruthy();

    const request = await Promise.race([
      got,
      new Promise((_, reject) => setTimeout(() => reject(new Error('no install_request ui_command within 20s')), 20_000)),
    ]);
    expect(request.request_id).toBe(sent.request_id);
    expect(request.source_project_id).toBe(sourceId);
    expect(request.origin?.kind).toBe('local');

    // What the Add-asset dialog does on Install: the same desk call.
    const result = await new dev1.sdk.Project({ id: targetId, type: 'project' }).installPublished(request);
    expect(result.id).toBe(skillId);
    const copied = path.join(targetRoot, '.claude', 'skills', skillName, 'SKILL.md');
    expect(existsSync(copied), `copied to ${copied}`).toBe(true);
    expect(readFileSync(copied, 'utf8')).toContain(`id: ${skillId}`);
    const deps = JSON.parse(readFileSync(path.join(targetRoot, 'agentic-assets', 'project_manifest', 'deps.json'), 'utf8'));
    expect(deps.entries.map((e: { typeid: string }) => e.typeid)).toEqual([typeid]);
    expect(deps.entries[0].source_project_id).toBe(sourceId);
    const rowOnDev1 = await jsonApi(dev1.apiUrl, `/graph/skill/${skillId}`);
    expect(rowOnDev1.data.project_id).toBe(targetId);
    // A dependency is not something the target published.
    const targetView = await jsonApi(dev1.apiUrl, `/graph/project/${targetId}/published`);
    expect(targetView.data.rows).toEqual([]);
  }, 30_000);

  it('`flow asset install <typeid>` — the snippet\'s last line — walks the same desk path from a bare typeid', () => {
    // The CLI holds a typeid and nothing else: the desk asks the hub who
    // published it (project/published_asset), then installs exactly as the
    // dialog does. Run from the CLI project's folder, so cwd is the target.
    const typeid = `skill-${skillId}`;
    const env = { ...process.env, FLOW_INSTANCE: INST_1, FLOWPAD_HUB_URL: HUB_URL };
    // `--project`: uv must resolve THIS checkout's flow, not whatever cwd implies.
    const out = execFileSync('uv', ['run', '--project', WORKTREE_ROOT, 'flow', 'asset', 'install', typeid], { cwd: cliRoot, env, encoding: 'utf8' });
    const result = JSON.parse(out.trim().split('\n').pop() as string);
    expect(result.ok).toBe(true);
    cliTargetId = result.project_id;
    expect(result.id).toBe(skillId);
    expect(existsSync(path.join(cliRoot, '.claude', 'skills', skillName, 'SKILL.md'))).toBe(true);
    const deps = JSON.parse(readFileSync(path.join(cliRoot, 'agentic-assets', 'project_manifest', 'deps.json'), 'utf8'));
    expect(deps.entries[0].source_project_id).toBe(sourceId);
  }, 30_000);
});
