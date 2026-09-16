/**
 * The hub-wide Discover directory, against a real hub and desk:
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
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSdkRealm, type OwnedSdkRealm } from '../_sdk_realm';
import { testEntityName } from '../_cleanup';
import { HUB_URL, getAliceCreds, hubAvailable, hubJson, hubLogin, localBackendIsCloudLoggedIn } from './_hub';
import { HUB_INST_1 as INST_1, getInstance, instanceAvailable, jsonApi, postApi, type ResolvedInstance } from './_instances';

let skipReason: string | null = null;
let dev1: ResolvedInstance;
let hub: OwnedSdkRealm;
let token = '';
let sourceId = '';
let targetId = '';
let sourceRoot = '';
let targetRoot = '';
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
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(targetRoot, { recursive: true });
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
    console.warn(`[discover_directory] skipped: ${skipReason}`);
    context.skip();
  }
});

afterAll(async () => {
  try {
    if (token && sourceId) await hubJson(token, `/graph/project/${sourceId}`, undefined, 'DELETE').catch(() => undefined);
    if (dev1 && sourceId) await jsonApi(dev1.apiUrl, `/graph/project/${sourceId}`, 'DELETE');
    if (dev1 && targetId) await jsonApi(dev1.apiUrl, `/graph/project/${targetId}`, 'DELETE');
  } finally {
    for (const p of [sourceRoot, targetRoot]) if (p && existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
});

describe('published_directory: the hub-wide Discover list', () => {
  it('lists what dev-2 published with its publisher, narrows by typeid, and says whether the document is on the hub', async () => {
    const typeid = `skill-${skillId}`;
    // The desk reflects the manifest in the background; poll the directory.
    let row: any;
    while (!row) {
      const dir = await hub.sdk.Project.getPublishedDirectory();
      row = dir.rows.find((r) => r.typeid === typeid);
      if (!row) await new Promise((r) => setTimeout(r, 200));
    }
    expect(row.source_project_id).toBe(sourceId);
    expect(row.source_project_name).toBe(path.basename(sourceRoot));
    expect(row.origin?.kind).toBe('local');
    expect(row.state).toBe('install');
    expect(row.body_supported).toBe(true);
    expect(row.body_available).toBe(false);
    expect(row.body_reason).toBe('not_on_hub');

    const one = await hub.sdk.Project.getPublishedDirectory({ typeid });
    expect(one.rows.map((r) => r.typeid)).toEqual([typeid]);
    expect(one.facets.projects.some((p) => p.id === sourceId)).toBe(true);

    const none = await hub.sdk.Project.getPublishedDirectory({ project: targetId });
    expect(none.rows).toEqual([]);

    // The desk's own view says what it did about the hub body. This rig has
    // no GitHub connection, so the hook stops at a gate — which one depends on
    // whether the hub row made the project count as linked — and never
    // reaches git.
    const desk = await jsonApi(dev1.apiUrl, `/graph/project/${sourceId}/published`);
    const deskRow = desk.data.rows.find((r: { typeid: string }) => r.typeid === typeid);
    expect(deskRow.hub_body.status).toBe('skipped');
    expect(['project_not_linked', 'github_not_connected']).toContain(deskRow.hub_body.code);
  }, 30_000);
});
