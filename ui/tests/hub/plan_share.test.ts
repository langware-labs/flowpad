/**
 * BUG TEST — sharing a PLAN (the plan-mode artifact: a ClaudePlan, type=`plan`,
 * read from Claude Code's `~/.claude/plans/<name>.md`) between conversation
 * members.
 *
 * Motivation (user report): "I shared a plan and on the other side it was
 * received just as a markdown file entity. plan/spec received should carry a
 * worker-launch button for immediate implementation." Two distinct "plan" kinds
 * exist in this codebase:
 *   - Spec(spec_type='plan')  → entity type `spec`  → covered by demo_plan_share.py
 *     and IS eligible for the conversation chip's "Implement Plan" button
 *     (gated on `specTypeId` in attachment-actions/registry.ts).
 *   - ClaudePlan (type='plan', sourced from `.claude/plans/*.md`, what plan-mode
 *     writes) → NOT a spec → not covered, and the receiver-side
 *     classification is the question this test pins.
 *
 * The asset_share_index_matrix test deliberately SKIPPED `plan` because a
 * DB-only `new Plan().save()` writes no plan file and plan TypeInfo has no
 * default_body_fn. This test closes that gap by SEEDING an isolated on-disk
 * Claude plan file on the sender and indexing that exact file as type=plan,
 * then driving the identical family share path.
 *
 * Contract under test (Alice → Bob): a shared plan must, on the receiver,
 *   (a) resolve in Bob's DB by the SENDER's id as type `plan` (id-pin round-trips),
 *   (b) land at Flowpad's canonical project placement,
 *       `<project>/agentic-assets/plan/<leaf>`,
 *   (c) NOT be misclassified/duplicated as a generic `markdown` doc
 *       (`agentic-assets` is a registry-derived protected typed subtree).
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
import { testEntityName } from '../_cleanup';
import {
  HUB_INST_1 as INST_1,
  HUB_INST_2 as INST_2,
  getInstance,
  instanceAvailable,
  type ResolvedInstance,
} from './_instances';

let skipReason: string | null = null;
let alice: ResolvedInstance;
let bob: ResolvedInstance;
// (instance, projectId, dir) triples to tear down in afterAll — both sides.
const createdProjects: Array<{ apiUrl: string; id: string; dir: string }> = [];
const createdEntities: Array<{ apiUrl: string; type: string; id: string }> = [];
const createdConversations: Array<{ apiUrl: string; id: string }> = [];

beforeAll(async () => {
  const hub = await hubAvailable();
  if (!hub.ok) return void (skipReason = hub.reason ?? 'hub unreachable');
  if (!instanceAvailable(INST_1) || !instanceAvailable(INST_2)) {
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
  for (const conversation of createdConversations) {
    await fetch(`${conversation.apiUrl}/api/v1/graph/conversation/${conversation.id}`, {
      method: 'DELETE',
    }).catch(() => undefined);
  }
  for (const entity of createdEntities) {
    await fetch(`${entity.apiUrl}/api/v1/graph/${entity.type}/${entity.id}`, {
      method: 'DELETE',
    }).catch(() => undefined);
  }
  for (const p of createdProjects) {
    await fetch(`${p.apiUrl}/api/v1/graph/project/${p.id}`, { method: 'DELETE' }).catch(() => undefined);
    try {
      rmSync(p.dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
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
  const r = await fetch(`${inst.apiUrl}/api/v1/graph/${type}/${id}`)
    .then((x) => x.json())
    .catch(() => null);
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
  await pollUntil(
    async () => {
      const r = await fetch(`${inst.apiUrl}/api/v1/graph/conversation/${convId}`).then((x) => x.json());
      return r?.data?.project_id === projectId ? true : null;
    },
    10_000,
    'conversation project_id persisted',
  );
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
  const planPath = path.join(plansDir, `${name}.md`);
  writeFileSync(
    planPath,
    `---\nid: ${id}\n---\n\n# ${name}\n\n## Step 1\n\nImplement the thing.\n`,
    'utf-8',
  );
  const created = await post(alice.apiUrl, '/graph/project', { name: path.basename(dir), fs_storage_mount_path: dir });
  const projectId = created.body?.data?.id;
  expect(projectId, 'alice seed project created').toBeTruthy();
  createdProjects.push({ apiUrl: alice.apiUrl, id: projectId, dir });
  createdEntities.push({ apiUrl: alice.apiUrl, type: 'plan', id });
  // Project `.claude/plans` is not Flowpad placement: only Claude Code's real
  // user-level store is part of the plan walker. Use the bounded exact-file
  // seam to model that harness artifact without writing into the user's home.
  const indexed = await post(
    alice.apiUrl,
    `/graph/compute_node/@local/fs-records/index?type=plan&path=${encodeURIComponent(planPath)}`,
  );
  expect(indexed.status, `exact plan index ok (got ${JSON.stringify(indexed.body?.message)})`).toBeLessThan(400);
  expect(indexed.body?.data?.typeid, 'exact plan index returned the pinned TypeId').toBe(`plan-${id}`);
  // Poll until the Plan entity materialized by the pinned id (id-pin on index).
  await pollUntil(
    async () => (await backendHas(alice, 'plan', id)) || null,
    15_000,
    'alice plan materialized as type=plan',
  );
  return { id, name };
}

/** Sender: create conv, invite Bob, attach the plan by TypeId, stage READY. */
async function sharePlan(planId: string): Promise<string> {
  const conv = new alice.sdk.Conversation({ title: testEntityName('conv-plan') });
  await conv.save();
  createdConversations.push({ apiUrl: alice.apiUrl, id: conv.id });
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
  return conv.id;
}

/** Receiver: sync the assignment and resolve the shared FlowMessage (READY). */
async function syncAndFindMessage(convId: string): Promise<{ fmId: string }> {
  // Pull only the assigned conversation. A broad fetchConversations() walks
  // every historical staff conversation and bundle, so this exact-id scenario
  // would grow with unrelated hub history.
  const sync = await post(bob.apiUrl, '/graph/conversation-message-sync', {
    conversation_id: convId,
  });
  expect(sync.status, `target conversation sync ok (got ${JSON.stringify(sync.body?.message)})`).toBeLessThan(400);
  const received = await pollUntil(
    async () => {
      const c = await bob.sdk.Conversation.getById(convId).catch(() => null);
      const ptrs = c?.conversationMessageIds ?? [];
      return ptrs.some((p: any) => p.type === 'flow_message') ? c : null;
    },
    20_000,
    'message pointer on receiver',
  );
  createdConversations.push({ apiUrl: bob.apiUrl, id: received.id });
  // Resolve the body-carrying message by readiness rather than pointer order.
  const fm = await pollUntil(
    async () => {
      const c = await bob.sdk.Conversation.getById(convId).catch(() => null);
      const ptrs = c?.conversationMessageIds ?? [];
      for (const p of ptrs as any[]) {
        if (p.type !== 'flow_message') continue;
        const full = await bob.sdk.FlowMessage.getById(p.id).catch(() => null);
        if (full && String(full.body_status) === 'ready') return full;
      }
      return null;
    },
    20_000,
    'shared message READY',
  );
  return { fmId: fm.id };
}

describe('plan share → receiver classification (Alice → Bob)', () => {
  it('a shared ClaudePlan is received AS a plan (not a plain markdown doc)', async () => {
    const { id: planId } = await seedPlanOnAlice();
    const convId = await sharePlan(planId);
    const { fmId } = await syncAndFindMessage(convId);

    const projectRoot = await createAndMapProject(bob, convId);

    // Staged reception: download stages a MessageAttachment (scope=null);
    // the explicit install action lands + indexes it in the project.
    const dl = await post(bob.apiUrl, `/graph/flow_message/${fmId}/download_body`, {});
    expect(dl.status, `download ok (got ${JSON.stringify(dl.body?.message)})`).toBeLessThan(400);
    const staged = await pollUntil(
      async () => {
        const r = await fetch(`${bob.apiUrl}/api/v1/graph/message_attachment`).then((x) => x.json());
        return ((r?.data ?? []) as any[]).find((m) => m.flow_message_id === fmId && m.asset_id === planId) ?? null;
      },
      10_000,
      'staged plan MessageAttachment on Bob',
    );
    expect(staged.asset_type, 'staged row is a plan').toBe('plan');
    const createdProject = createdProjects[createdProjects.length - 1];
    const install = await post(bob.apiUrl, `/graph/message_attachment/${staged.id}/install`, {
      scope: 'project',
      project_id: createdProject.id,
    });
    expect(install.status, `install ok (got ${JSON.stringify(install.body?.message)})`).toBeLessThan(400);
    createdEntities.push({ apiUrl: bob.apiUrl, type: 'plan', id: planId });

    // (a) Bob resolves it by the SENDER's id as type `plan` (id-pin round-trips).
    const asPlan = await pollUntil(
      async () => (await backendHas(bob, 'plan', planId)) || null,
      10_000,
      "plan resolvable in Bob's DB by sender id",
    ).catch(() => false);

    // (b) On disk under Flowpad's canonical project Plan placement.
    const plansSubdir = path.join(projectRoot, 'agentic-assets', 'plan');
    expect(existsSync(plansSubdir), `plans subdir ${plansSubdir}`).toBe(true);
    expect(readdirSync(plansSubdir).length, `plan file present under ${plansSubdir}`).toBeGreaterThan(0);

    // (c) It must NOT also materialize as a generic markdown doc under the same
    // id. The registry-derived typed-directory guard excludes the entire
    // `agentic-assets` subtree from the markdown catch-all walker.
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
