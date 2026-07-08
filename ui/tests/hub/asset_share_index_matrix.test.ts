/**
 * BUG TEST — asset sharing + STAGED reception between conversation members
 * (FAMILY model, staged-reception contract as of f1276cd5).
 *
 * Contract under test (Alice → Bob, two SDK realms in one process via
 * `getInstance`): a file-backed asset shared by TYPE_ID rides the `.flowmsg`
 * bundle. On the receiver, download STAGES it under the message's record-data
 * dir and mints a MessageAttachment row (scope=null) — it does NOT copy into
 * any project or index. The explicit `install` action (the review modal's
 * button) copies into the chosen project at `<project>/<TypeInfo subdir>/<leaf>`
 * and indexes from there. ONE family handler — no per-type code.
 *
 *   1. Alice invites Bob; Bob accepts.
 *   2. Alice shares an asset BY TYPE_ID; Bob downloads → STAGED (no entity,
 *      MessageAttachment scope=null); no project mapping is needed to download.
 *   3. Bob installs into a real project. For every file-backed type, Bob must:
 *        (a) resolve it in his DB by the SENDER's id (id-pin round-trips),
 *        (a2) see it appear on the LIVE data layer via a CREATE data_op,
 *        (b) find it on disk under `<project>/<main_subdir>/…`.
 *
 * Requires the local hub (8093) + two launched instances (SHARE_INST_1/2,
 * default dev-1/dev-2). Skips otherwise.
 *   scripts/instance_ctl.sh launch dev-1 && scripts/instance_ctl.sh launch dev-2
 *   (cd ui && FLOWPAD_HUB_URL=http://localhost:8093 SHARE_INST_1=dev-1 SHARE_INST_2=dev-2 \
 *      npx vitest run --project hub asset_share_index_matrix)
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hubAvailable } from './_hub';
import { pollUntil } from './_matrix';
import { testEntityName, trackForCleanup } from '../_cleanup';
import {
  findPendingInvitation,
  getInstance,
  instanceAvailable,
  type ResolvedInstance,
} from './_instances';

const INST_1 = process.env.SHARE_INST_1 || 'dev-1';
const INST_2 = process.env.SHARE_INST_2 || 'dev-2';

let skipReason: string | null = null;
let alice: ResolvedInstance;
let bob: ResolvedInstance;
// Projects this test creates on Bob — torn down in afterAll so they don't
// pollute the project picker for other hub tests (share_matrix.ui picks first()).
const createdProjects: Array<{ id: string; dir: string }> = [];

beforeAll(async () => {
  const hub = await hubAvailable();
  if (!hub.ok) return void (skipReason = hub.reason ?? 'hub unreachable');
  if (!(await instanceAvailable(INST_1)) || !(await instanceAvailable(INST_2))) {
    return void (skipReason = `launch ${INST_1} + ${INST_2} via scripts/instance_ctl.sh`);
  }
  alice = await getInstance(INST_1);
  bob = await getInstance(INST_2);
}, 30_000); // do not increase timeout without approval

beforeEach((context: any) => {
  if (skipReason) context.skip();
});

// This test legitimately materializes conversations on BOTH instances (Alice
// creates + shares; Bob receives a remote copy). The global single-realm leak
// sweep can't reach the receiver's copy, so purge our test conversations on
// both backends directly — by title prefix, covering both sides + any retries.
afterAll(async () => {
  if (skipReason || !alice || !bob) return;
  // This test materializes entities on BOTH instances (Alice creates + shares;
  // Bob receives a copy into his project). The global single-realm leak sweep
  // can't reach Bob's copies, so purge our e2etest-* rows on both backends
  // directly — conversations + every asset type the leak sweep checks.
  const SWEEP_TYPES = ['conversation', 'skill', 'agent', 'workflow', 'whiteboard', 'markdown', 'spec', 'prompt'];
  for (const inst of [alice, bob]) {
    for (const type of SWEEP_TYPES) {
      const list = await fetch(`${inst.apiUrl}/api/v1/graph/${type}`).then((r) => r.json()).catch(() => null);
      for (const r of (list?.data ?? []) as any[]) {
        const label = String(r?.title ?? r?.name ?? '');
        if (label.startsWith('e2etest-') && r?.id) {
          await fetch(`${inst.apiUrl}/api/v1/graph/${type}/${r.id}`, { method: 'DELETE' }).catch(() => undefined);
        }
      }
    }
  }
  // Tear down the projects we created (rows + tmp dirs) so they don't pollute
  // the "Set project" picker that other hub tests rely on.
  for (const p of createdProjects) {
    await fetch(`${bob.apiUrl}/api/v1/graph/project/${p.id}`, { method: 'DELETE' }).catch(() => undefined);
    try { rmSync(p.dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

const api = (apiUrl: string, method: string, p: string, body?: unknown) =>
  fetch(`${apiUrl}/api/v1${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  }).then((r) => r.json().then((j) => ({ status: r.status, body: j })));

const post = (apiUrl: string, p: string, body?: unknown) => api(apiUrl, 'POST', p, body);

/** Force a real backend round-trip on Bob (NOT the SDK cache). */
async function bobBackendHas(type: string, id: string): Promise<boolean> {
  const r = await fetch(`${bob.apiUrl}/api/v1/graph/${type}/${id}`).then((x) => x.json());
  return r?.status === 'SUCCESS' && r?.data?.id === id;
}

/** Create a real project dir on disk on Bob — the INSTALL target. (Staged
 *  reception needs no conversation→project mapping to download; the project id
 *  is passed explicitly to the install action, like the review modal does.) */
async function createProject(): Promise<{ id: string; dir: string }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'flowpad-proj-'));
  const created = await post(bob.apiUrl, '/graph/project', {
    name: path.basename(dir),
    fs_storage_mount_path: dir,
  });
  const projectId = created.body?.data?.id;
  expect(projectId, 'project created on Bob').toBeTruthy();
  createdProjects.push({ id: projectId, dir });
  return { id: projectId, dir };
}

/** Bob's staged MessageAttachment for (fmId, asset id) — backend read, no cache. */
async function findStagedAttachment(fmId: string, assetId: string): Promise<any | null> {
  const r = await fetch(`${bob.apiUrl}/api/v1/graph/message_attachment`).then((x) => x.json());
  const rows = (r?.data ?? []) as any[];
  return rows.find((m) => m.flow_message_id === fmId && m.asset_id === assetId) ?? null;
}

/** A shareable file-backed asset type + how to create it on the sender. */
interface AssetSpec {
  type: string;
  mainSubdir: string; // <project>/<mainSubdir>/<leaf>
  create: (sdk: any) => Promise<{ id: string; name: string }>;
}

const ASSETS: AssetSpec[] = [
  { type: 'skill', mainSubdir: '.claude/skills',
    create: async (sdk) => { const s = trackForCleanup(await sdk.Skill.create(testEntityName('skill'))); return { id: s.id!, name: s.name ?? s.title }; } },
  { type: 'agent', mainSubdir: '.claude/agents',
    create: async (sdk) => { const a = trackForCleanup(await sdk.Agent.createInProject(null, testEntityName('agent'))); return { id: a.id!, name: a.name ?? a.title }; } },
  { type: 'workflow', mainSubdir: '.claude/workflows',
    create: async (sdk) => { const w = trackForCleanup(await sdk.Workflow.create(testEntityName('workflow'))); return { id: w.id!, name: w.name ?? w.title }; } },
  { type: 'markdown', mainSubdir: 'docs',
    create: async (sdk) => { const m = trackForCleanup(await sdk.Markdown.createInProject(null, testEntityName('markdown'))); return { id: m.id!, name: m.name ?? m.title }; } },
  { type: 'spec', mainSubdir: 'specs',
    create: async (sdk) => { const s = trackForCleanup(new sdk.Spec({ title: testEntityName('spec'), content: '# Spec body\n' })); await s.save(); return { id: s.id!, name: s.title ?? s.name }; } },
  { type: 'prompt', mainSubdir: 'prompts',
    create: async (sdk) => { const p = trackForCleanup(await sdk.Prompt.create({ name: testEntityName('prompt'), text: 'do the thing' })); return { id: p.id!, name: p.name ?? p.title }; } },
  // whiteboard: a folder-layout asset whose board.json + WHITE_BOARD.md
  // materialize lazily on editor mount, NOT on create() — so a bare SDK create
  // ships nothing. Seed the two files the editor's first save would write (the
  // instances run on this host, so asset_ref is a real local path), then it
  // rides the identical file-backed family path as every other type.
  { type: 'whiteboard', mainSubdir: '.claude/whiteboards',
    create: async (sdk) => {
      const name = testEntityName('whiteboard');
      const wb = trackForCleanup(await sdk.Whiteboard.create(name));
      const assetRef = (wb as { asset_ref?: string }).asset_ref;
      if (assetRef) {
        const { promises: nodeFs } = await import('node:fs');
        await nodeFs.mkdir(assetRef, { recursive: true });
        await nodeFs.writeFile(
          `${assetRef}/board.json`,
          JSON.stringify({ kind: 'excalidraw', version: 1, data: { elements: [] } }),
        );
        await nodeFs.writeFile(`${assetRef}/WHITE_BOARD.md`, `# ${name}\n`);
      }
      return { id: wb.id!, name: wb.name ?? wb.title };
    } },
];

// NOTE on coverage: these 7 types' on-disk asset_ref exercises the full family
// path (pack → copy-to-project → index). whiteboard's source is seeded above
// (its files materialize lazily on editor mount, not on create()). Two more
// file-backed types ride the SAME generic handler but have no on-disk source to
// seed in this harness, so they're tracked separately:
//   - plan: an API-created `new Plan().save()` writes no .claude/plans/<n>.md and
//     plan TypeInfo has no default_body_fn, so the DB-only entity can't render a
//     body to ship. (command/rule have no SDK create at all.)
// Their share path is identical once an on-disk asset_ref exists; the gap is in
// test-asset CREATION, not the share/copy/index refactor.

/** Sender: create a conv, invite Bob, attach the asset by TypeId, stage READY. */
async function shareAsset(spec: AssetSpec): Promise<{ convId: string; created: { id: string; name: string } }> {
  const created = await spec.create(alice.sdk);
  expect(created.id, `${spec.type} created`).toBeTruthy();

  const conv = trackForCleanup(new alice.sdk.Conversation({ title: testEntityName(`conv-${spec.type}`) }));
  await conv.save();
  await conv.share([bob.email]);
  expect(conv.remote).toBe(true);

  const add = await post(alice.apiUrl, `/graph/conversation/${conv.id}/add_message`, {
    message: `here is a ${spec.type} for you`,
    asset_references: [`${spec.type}-${created.id}`],
  });
  const fmId = add.body.data?.flow_message_id as string;
  expect(fmId, `${spec.type} flow_message_id`).toBeTruthy();
  const upload = await post(alice.apiUrl, `/graph/flow_message/${fmId}/upload_body`, {});
  expect(upload.body.data?.body_status, `${spec.type} body READY`).toBe('ready');
  return { convId: conv.id!, created };
}

/** Receiver: accept the invitation and resolve the shared FlowMessage (READY). */
async function acceptAndFindMessage(convId: string): Promise<{ fmId: string }> {
  const invitation = await pollUntil(() => findPendingInvitation(bob, convId), 20_000, 'pending invitation');
  await bob.sdk.acceptInvitation({ invitation_id: invitation.id! });

  const received = await pollUntil(async () => {
    await bob.sdk.fetchConversations();
    const c = await bob.sdk.Conversation.getById(convId).catch(() => null);
    const ptrs = c?.conversationMessageIds ?? [];
    return ptrs.some((p: any) => p.type === 'flow_message') ? c : null;
  }, 20_000, 'message pointer on receiver');
  // Register Bob's materialized conversation copy so the global leak sweep
  // purges it (it's created backend-side on receive, not via trackForCleanup).
  trackForCleanup(received);

  // The conversation strip carries TWO flow_message pointers: the shared ASSET
  // message (rides a body bundle → body_status flips to READY) AND a
  // kind='invitation' placeholder row ("You've been invited…", no body, stays
  // body_status=na). Both are typed 'flow_message', and the invitation
  // placeholder is materialized synchronously on accept — so it wins the race
  // against the slower catch-up asset message. Don't pin to the FIRST pointer;
  // poll ALL of them (re-fetching, since the asset message lands via background
  // catch-up shortly after accept) and select the one that actually carries the
  // uploaded bundle (body_status READY). The placeholder never becomes READY.
  const fm = await pollUntil(async () => {
    await bob.sdk.fetchConversations();
    const c = await bob.sdk.Conversation.getById(convId).catch(() => null);
    const ptrs = c?.conversationMessageIds ?? [];
    for (const p of ptrs as any[]) {
      if (p.type !== 'flow_message') continue;
      const full = await bob.sdk.FlowMessage.getById(p.id).catch(() => null);
      if (full && full.body_status === 'ready') return full;
    }
    return null;
  }, 20_000, 'shared message READY');
  return { fmId: fm.id };
}

describe('asset share → staged → install-to-project → index matrix (Alice → Bob)', () => {
  for (const spec of ASSETS) {
    it(`${spec.type}: stages on download, installs into Bob's project, resolves by sender id`, async () => {
      const { convId, created } = await shareAsset(spec);
      const { fmId } = await acceptAndFindMessage(convId);

      // The install target — no conversation mapping needed to download.
      const project = await createProject();

      // Prime the receiver's LIVE data layer the way the conversation chip does:
      // the bubble mounts and resolves the asset's TypeId BEFORE the bytes
      // arrive, so dataManager 404s and negative-caches it (`useEntity` →
      // dataManager.getByTypeId; the chip renders "not found locally").
      const tid = new bob.sdk.TypeId(spec.type, created.id);
      const preDownload = await (bob.sdk.dataManager as any).getByTypeId(tid).catch(() => null);
      expect(preDownload, `${spec.type} not resolvable on Bob BEFORE download (primes negative cache)`).toBeNull();

      // Explicit download → STAGED under the message's record-data dir.
      const dl = await post(bob.apiUrl, `/graph/flow_message/${fmId}/download_body`, {});
      expect(dl.status, `${spec.type} download ok (got ${JSON.stringify(dl.body?.message)})`).toBeLessThan(400);

      // Staged contract: a MessageAttachment row exists (scope=null) and the
      // asset entity does NOT — nothing entered Bob's work areas yet.
      const staged = await pollUntil(
        () => findStagedAttachment(fmId, created.id),
        10_000, `${spec.type} staged MessageAttachment on Bob`,
      );
      expect(staged.asset_type, `${spec.type} staged row type`).toBe(spec.type);
      expect(staged.scope, `${spec.type} staged (uninstalled) scope`).toBeFalsy();
      expect(await bobBackendHas(spec.type, created.id), `${spec.type} NOT materialized pre-install`).toBe(false);

      // Explicit install into the chosen project (the review modal's action).
      const install = await post(bob.apiUrl, `/graph/message_attachment/${staged.id}/install`, {
        scope: 'project',
        project_id: project.id,
      });
      expect(install.status, `${spec.type} install ok (got ${JSON.stringify(install.body?.message)})`).toBeLessThan(400);

      // (a) resolvable in Bob's DB by the SENDER's id (id-pin round-trips).
      const resolved = await pollUntil(
        async () => (await bobBackendHas(spec.type, created.id)) || null,
        10_000, `${spec.type} resolvable in Bob's DB`,
      ).catch(() => false);
      expect(resolved, `${spec.type} resolvable on Bob by sender id`).toBe(true);

      // (a2) The receiver's LIVE data layer must learn the asset exists WITHOUT
      // a manual refetch — install announces the new entity as a CREATE data_op
      // so the SDK's negative cache (primed above) self-heals and
      // dataManager.getByTypeId starts returning it. This is the exact path the
      // conversation chip uses (useEntity) to flip dashed→solid — no reload.
      const live = await pollUntil(
        async () => (await (bob.sdk.dataManager as any).getByTypeId(tid).catch(() => null)),
        10_000, `${spec.type} resolves on Bob's live data layer (CREATE data_op)`,
      ).catch(() => null);
      expect(live?.id, `${spec.type} live-resolvable on Bob without refetch (CREATE data_op fired)`).toBe(created.id);

      // Register Bob's materialized asset copy for the global leak sweep.
      const ClsName = spec.type.charAt(0).toUpperCase() + spec.type.slice(1);
      const bobEntity = await (bob.sdk as any)[ClsName]?.getById?.(created.id).catch(() => null);
      if (bobEntity) trackForCleanup(bobEntity);

      // (b) on disk under <project>/<main_subdir>/… (installed, not in ~/.claude).
      const subdir = path.join(project.dir, spec.mainSubdir);
      expect(existsSync(subdir), `${spec.type} subdir ${subdir}`).toBe(true);
      expect(readdirSync(subdir).length, `${spec.type} asset present under ${subdir}`).toBeGreaterThan(0);
    }, 30_000); // do not increase timeout without approval
  }

  it('no-project download: succeeds and stages (consent boundary — nothing lands)', async () => {
    const spec = ASSETS[0]; // skill
    const { convId, created } = await shareAsset(spec);
    const { fmId } = await acceptAndFindMessage(convId);
    // Download WITHOUT any project anywhere — must succeed (staging needs none).
    const dl = await post(bob.apiUrl, `/graph/flow_message/${fmId}/download_body`, {});
    expect(dl.status, `no-project download ok (got ${JSON.stringify(dl.body?.message)})`).toBeLessThan(400);
    // Staged, not installed: MessageAttachment exists, the asset entity does not.
    const staged = await pollUntil(
      () => findStagedAttachment(fmId, created.id),
      10_000, 'staged MessageAttachment (no project)',
    );
    expect(staged.scope, 'staged scope').toBeFalsy();
    expect(await bobBackendHas(spec.type, created.id), 'no entity without install').toBe(false);
    // Install without a project_id is refused — project scope needs a target.
    const bad = await post(bob.apiUrl, `/graph/message_attachment/${staged.id}/install`, { scope: 'project' });
    expect(bad.status, 'project install without project_id → 400').toBe(400);
  }, 30_000); // do not increase timeout without approval
});
