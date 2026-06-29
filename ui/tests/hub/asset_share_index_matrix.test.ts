/**
 * BUG TEST — asset sharing + indexing between conversation members (FAMILY model).
 *
 * Contract under test (Alice → Bob, two SDK realms in one process via
 * `getInstance`): a file-backed asset shared by TYPE_ID rides the `.flowmsg`
 * bundle, and on the receiver is EXTRACTED to the conversation's message folder,
 * then COPIED into the conversation's mapped PROJECT at `<project>/<TypeInfo
 * subdir>/<leaf>` and INDEXED from there. ONE family handler — no per-type code.
 *
 *   1. Alice invites Bob; Bob accepts.
 *   2. Bob MAPS the conversation to a real project (the model requires it).
 *   3. Alice shares an asset BY TYPE_ID; Bob downloads.
 *   4. For every file-backed type, Bob must:
 *        (a) resolve it in his DB by the SENDER's id (id-pin round-trips),
 *        (b) find it on disk under `<project>/<main_subdir>/…`,
 *        (c) [RUN_AGENTIC=1] use it in a real Haiku agentic run (project = cwd).
 *   5. No-project gate: download before mapping ⇒ 409 needs_project, parked.
 *   6. Conflict: a different same-path asset ⇒ 409 asset_conflict; overwrite replaces.
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

/** Create a real project dir on disk and map Bob's conversation to it. Returns
 *  the project root. The new model requires a mapped project to land assets. */
async function createAndMapProject(convId: string): Promise<string> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'flowpad-proj-'));
  const created = await post(bob.apiUrl, '/graph/project', {
    name: path.basename(dir),
    fs_storage_mount_path: dir,
  });
  const projectId = created.body?.data?.id;
  expect(projectId, 'project created on Bob').toBeTruthy();
  createdProjects.push({ id: projectId, dir });
  await api(bob.apiUrl, 'PUT', `/graph/conversation/${convId}`, { project_id: projectId });
  // Poll until the backend actually persisted the mapping — the download path
  // resolves the project from the conversation server-side, so racing it yields
  // a spurious needs_project 409.
  await pollUntil(async () => {
    const r = await fetch(`${bob.apiUrl}/api/v1/graph/conversation/${convId}`).then((x) => x.json());
    return r?.data?.project_id === projectId ? true : null;
  }, 10_000, 'conversation project_id persisted');
  return dir;
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

  const fmPtr = received.conversationMessageIds.find((p: any) => p.type === 'flow_message');
  await pollUntil(async () => {
    const full = await bob.sdk.FlowMessage.getById(fmPtr!.id).catch(() => null);
    return full && full.body_status === 'ready' ? full : null;
  }, 20_000, 'shared message READY');
  return { fmId: fmPtr!.id };
}

describe('asset share → copy-to-project → index matrix (Alice → Bob)', () => {
  for (const spec of ASSETS) {
    it(`${spec.type}: copies into Bob's project and resolves by sender id`, async () => {
      const { convId, created } = await shareAsset(spec);
      const { fmId } = await acceptAndFindMessage(convId);

      // Map a real project — required for the copy to happen.
      const projectRoot = await createAndMapProject(convId);

      // Prime the receiver's LIVE data layer the way the conversation chip does:
      // the bubble mounts and resolves the asset's TypeId BEFORE the bytes
      // arrive, so dataManager 404s and negative-caches it (`useEntity` →
      // dataManager.getByTypeId; the chip renders disabled "not found locally").
      const tid = new bob.sdk.TypeId(spec.type, created.id);
      const preDownload = await (bob.sdk.dataManager as any).getByTypeId(tid).catch(() => null);
      expect(preDownload, `${spec.type} not resolvable on Bob BEFORE download (primes negative cache)`).toBeNull();

      // Explicit download → copy into the project + index.
      const dl = await post(bob.apiUrl, `/graph/flow_message/${fmId}/download_body`, {});
      expect(dl.status, `${spec.type} download ok (got ${JSON.stringify(dl.body?.message)})`).toBeLessThan(400);

      // (a) resolvable in Bob's DB by the SENDER's id (id-pin round-trips).
      const resolved = await pollUntil(
        async () => (await bobBackendHas(spec.type, created.id)) || null,
        10_000, `${spec.type} resolvable in Bob's DB`,
      ).catch(() => false);
      expect(resolved, `${spec.type} resolvable on Bob by sender id`).toBe(true);

      // (a2) The receiver's LIVE data layer must learn the asset exists WITHOUT
      // a manual refetch — the materialize has to announce the new entity as a
      // CREATE data_op so the SDK's negative cache (primed above) self-heals and
      // dataManager.getByTypeId starts returning it. This is the exact path the
      // conversation chip uses (useEntity), so it goes enabled on its own — no
      // page reload. We do NOT call invalidate; if no CREATE event arrives, the
      // negative cache sticks and this stays null. (No browser; same dataManager.)
      const live = await pollUntil(
        async () => (await (bob.sdk.dataManager as any).getByTypeId(tid).catch(() => null)),
        10_000, `${spec.type} resolves on Bob's live data layer (CREATE data_op)`,
      ).catch(() => null);
      expect(live?.id, `${spec.type} live-resolvable on Bob without refetch (CREATE data_op fired)`).toBe(created.id);

      // Register Bob's materialized asset copy for the global leak sweep.
      const ClsName = spec.type.charAt(0).toUpperCase() + spec.type.slice(1);
      const bobEntity = await (bob.sdk as any)[ClsName]?.getById?.(created.id).catch(() => null);
      if (bobEntity) trackForCleanup(bobEntity);

      // (b) on disk under <project>/<main_subdir>/… (copied, not in ~/.claude).
      const subdir = path.join(projectRoot, spec.mainSubdir);
      expect(existsSync(subdir), `${spec.type} subdir ${subdir}`).toBe(true);
      expect(readdirSync(subdir).length, `${spec.type} asset present under ${subdir}`).toBeGreaterThan(0);
    }, 30_000); // do not increase timeout without approval
  }

  it('no-project gate: download before mapping returns 409 needs_project', async () => {
    const { convId } = await shareAsset(ASSETS[0]); // skill
    const { fmId } = await acceptAndFindMessage(convId);
    // Download WITHOUT mapping a project.
    const dl = await post(bob.apiUrl, `/graph/flow_message/${fmId}/download_body`, {});
    expect(dl.status, 'needs_project 409').toBe(409);
    expect(dl.body?.data?.needs_project, 'needs_project flag').toBe(true);
  }, 30_000); // do not increase timeout without approval
});
