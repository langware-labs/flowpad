/**
 * BUG TEST — sharing a PLAN (the plan-mode artifact: a ClaudePlan, type=`plan`,
 * living at `<root>/.claude/plans/<name>.md`) between conversation members.
 *
 * Motivation (user report): "I shared a plan and on the other side it was
 * received just as a markdown file entity. plan/spec received should carry a
 * worker-launch button for immediate implementation." Two distinct "plan" kinds
 * exist in this codebase:
 *   - Spec(spec_type='plan')  → entity type `spec`  → covered by demo_plan_share.py
 *     and IS eligible for the conversation chip's "Implement Plan" button
 *     (gated on `specTypeId` in attachment-actions/registry.ts).
 *   - ClaudePlan (type='plan', `.claude/plans/*.md`, what plan-mode writes) →
 *     NOT a spec → not covered, and the receiver-side classification is the
 *     question this test pins.
 *
 * The asset_share_index_matrix test deliberately SKIPPED `plan` because a
 * DB-only `new Plan().save()` writes no `.claude/plans/<n>.md` and plan TypeInfo
 * has no default_body_fn. This test closes that gap by SEEDING a real on-disk
 * plan on the sender (write the file + index a scoped project so the Plan entity
 * materializes), then driving the identical family share path.
 *
 * Contract under test (Alice → Bob): a shared plan must, on the receiver,
 *   (a) resolve in Bob's DB by the SENDER's id as type `plan` (id-pin round-trips),
 *   (b) land on disk under `<project>/.claude/plans/<leaf>`,
 *   (c) NOT be misclassified/duplicated as a generic `markdown` doc
 *       (the `_TYPED_RECORD_DIRS` gap: "plans" is not a protected typed dir, so
 *        the markdown catch-all walker can also claim the same .md).
 *
 * Requires the local hub (8093) + two launched instances (SHARE_INST_1/2,
 * default dev-1/dev-2). Skips otherwise.
 *   scripts/instance_ctl.sh launch dev-1 && scripts/instance_ctl.sh launch dev-2
 *   (cd ui && FLOWPAD_HUB_URL=http://localhost:8093 SHARE_INST_1=dev-1 SHARE_INST_2=dev-2 \
 *      npx vitest run --project hub plan_share)
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
// (instance, projectId, dir) triples to tear down in afterAll — both sides.
const createdProjects: Array<{ apiUrl: string; id: string; dir: string }> = [];

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

afterAll(async () => {
  if (skipReason || !alice || !bob) return;
  const SWEEP_TYPES = ['conversation', 'plan', 'markdown'];
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
  for (const p of createdProjects) {
    await fetch(`${p.apiUrl}/api/v1/graph/project/${p.id}`, { method: 'DELETE' }).catch(() => undefined);
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

async function backendHas(inst: ResolvedInstance, type: string, id: string): Promise<boolean> {
  const r = await fetch(`${inst.apiUrl}/api/v1/graph/${type}/${id}`).then((x) => x.json()).catch(() => null);
  return r?.status === 'SUCCESS' && r?.data?.id === id;
}

/** Create a real project dir on disk and map a conversation to it. */
async function createAndMapProject(inst: ResolvedInstance, convId: string): Promise<string> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'flowpad-proj-'));
  const created = await post(inst.apiUrl, '/graph/project', { name: path.basename(dir), fs_storage_mount_path: dir });
  const projectId = created.body?.data?.id;
  expect(projectId, 'project created').toBeTruthy();
  createdProjects.push({ apiUrl: inst.apiUrl, id: projectId, dir });
  await api(inst.apiUrl, 'PUT', `/graph/conversation/${convId}`, { project_id: projectId });
  await pollUntil(async () => {
    const r = await fetch(`${inst.apiUrl}/api/v1/graph/conversation/${convId}`).then((x) => x.json());
    return r?.data?.project_id === projectId ? true : null;
  }, 10_000, 'conversation project_id persisted');
  return dir;
}

/** Seed a real ClaudePlan on the sender: write `.claude/plans/<name>.md` (id
 *  pinned into frontmatter) into a fresh project dir, then index that project so
 *  the Plan entity materializes with asset_ref = the file. Returns id + name. */
async function seedPlanOnAlice(): Promise<{ id: string; name: string }> {
  const name = testEntityName('plan');
  const id = randomUUID(); // v4 → valid entity id, pinned into frontmatter
  const dir = mkdtempSync(path.join(os.tmpdir(), 'flowpad-planseed-'));
  const plansDir = path.join(dir, '.claude', 'plans');
  mkdirSync(plansDir, { recursive: true });
  writeFileSync(
    path.join(plansDir, `${name}.md`),
    `---\nid: ${id}\n---\n\n# ${name}\n\n## Step 1\n\nImplement the thing.\n`,
    'utf-8',
  );
  const created = await post(alice.apiUrl, '/graph/project', { name: path.basename(dir), fs_storage_mount_path: dir });
  const projectId = created.body?.data?.id;
  expect(projectId, 'alice seed project created').toBeTruthy();
  createdProjects.push({ apiUrl: alice.apiUrl, id: projectId, dir });
  // Scope the index to ONLY this project (user=false&projects=id → one
  // REAL_PROJECT_CWD root → walks just the seed dir, fast).
  await post(alice.apiUrl, `/graph/compute_node/@local/fs-records/index?user=false&projects=${projectId}`);
  // Poll until the Plan entity materialized by the pinned id (id-pin on index).
  await pollUntil(async () => (await backendHas(alice, 'plan', id)) || null, 15_000, 'alice plan materialized as type=plan');
  return { id, name };
}

/** Sender: create conv, invite Bob, attach the plan by TypeId, stage READY. */
async function sharePlan(planId: string): Promise<string> {
  const conv = trackForCleanup(new alice.sdk.Conversation({ title: testEntityName('conv-plan') }));
  await conv.save();
  await conv.share([bob.email]);
  expect(conv.remote).toBe(true);
  const add = await post(alice.apiUrl, `/graph/conversation/${conv.id}/add_message`, {
    message: 'here is a plan for you',
    asset_references: [`plan-${planId}`],
  });
  const fmId = add.body.data?.flow_message_id as string;
  expect(fmId, 'plan flow_message_id').toBeTruthy();
  const upload = await post(alice.apiUrl, `/graph/flow_message/${fmId}/upload_body`, {});
  expect(upload.body.data?.body_status, 'plan body READY').toBe('ready');
  return conv.id!;
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
  trackForCleanup(received);
  // Two flow_message pointers land on the receiver: the shared ASSET message
  // (rides a body bundle → body_status READY) AND a kind='invitation'
  // placeholder ("You've been invited…", no body, stays body_status=na). Both
  // are typed 'flow_message'; the placeholder is materialized synchronously on
  // accept and wins the race against the slower catch-up asset message. Don't
  // pin to the FIRST pointer — poll ALL of them (re-fetching) and select the one
  // that carries the uploaded bundle (body_status READY). The placeholder never
  // becomes READY.
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

describe('plan share → receiver classification (Alice → Bob)', () => {
  it('a shared ClaudePlan is received AS a plan (not a plain markdown doc)', async () => {
    const { id: planId } = await seedPlanOnAlice();
    const convId = await sharePlan(planId);
    const { fmId } = await acceptAndFindMessage(convId);

    const projectRoot = await createAndMapProject(bob, convId);

    const dl = await post(bob.apiUrl, `/graph/flow_message/${fmId}/download_body`, {});
    expect(dl.status, `download ok (got ${JSON.stringify(dl.body?.message)})`).toBeLessThan(400);

    // (a) Bob resolves it by the SENDER's id as type `plan` (id-pin round-trips).
    const asPlan = await pollUntil(
      async () => (await backendHas(bob, 'plan', planId)) || null,
      10_000, "plan resolvable in Bob's DB by sender id",
    ).catch(() => false);

    // (b) On disk under <project>/.claude/plans/.
    const plansSubdir = path.join(projectRoot, '.claude', 'plans');
    expect(existsSync(plansSubdir), `plans subdir ${plansSubdir}`).toBe(true);
    expect(readdirSync(plansSubdir).length, `plan file present under ${plansSubdir}`).toBeGreaterThan(0);

    // (c) It must NOT also materialize as a generic markdown doc under the same
    // id. The receiver's reindex is scoped to RecordType.PLAN, so the markdown
    // catch-all walker (which would otherwise claim `.claude/plans/*.md` — the
    // `_TYPED_RECORD_DIRS` gap) does not run here; this guards that scoping.
    const asMarkdown = await backendHas(bob, 'markdown', planId);
    expect(asMarkdown, 'shared plan must NOT also duplicate as a markdown doc').toBe(false);

    // The user's bug: received "just as markdown file entity" → asPlan false /
    // asMarkdown true. Correct behaviour → asPlan true. This assertion pins it.
    expect(
      asPlan,
      `shared plan must resolve on Bob as type=plan (asPlan=${asPlan}, asMarkdown=${asMarkdown}). ` +
      `If false, the receiver mis-classified the plan — the reported bug.`,
    ).toBe(true);
  }, 30_000); // do not increase timeout without approval
});
