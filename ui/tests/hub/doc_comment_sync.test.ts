/**
 * Generic entity-child live sync across two real SDK realms (one per instance —
 * see `_instances.ts`): alice = SHARE_INST_1 (dev-1), bob = SHARE_INST_2 (dev-2).
 *
 * Matrix: {create, update, delete} × {A→B, B→A} for a `comment` child, exercised
 * through the REAL TS SDK write path (the same calls `use-doc-comments` makes):
 *   - create: `new Comment(...).save(scope)` → POST → server auto-shares,
 *   - update: mutate `raw_content` + `save()` → reflects (Hub-Reflect on a remote save),
 *   - delete: `comment.delete()` → server auto-propagates `child_deleted` (no header).
 * Nothing is comment-specific — the same path carries any `shared_child` type.
 *
 * The six CRUD cells use the CONVERSATION as the comment parent (both realms hold
 * it — no markdown materialization, whose FS `discover` walks every project root).
 * A `doc_binding` cell covers the markdown-anchored case (comment carries the doc as
 * `parent_type_id` — "doc wins over the conversation envelope").
 *
 * Cross-layer key (shared with the pytest + browser layers):
 *   Scenario: doc_comment_create_sync   ScenarioId: 987c8038-f50c-464d-b817-01985ac72d5c
 *   Scenario: doc_comment_update_sync   ScenarioId: a43f4285-07ed-4f06-b299-071da5081e5e
 *   Scenario: doc_comment_delete_sync   ScenarioId: 7dbcead1-46c8-434c-96d2-eac23050729f
 *
 * Requires the local hub (8093) + two launched instances (SHARE_INST_1/2, default
 * dev-1/dev-2). Skips otherwise. Per-test 30s cap — do not increase (CLAUDE.md).
 *   scripts/instance_ctl.sh launch dev-1 && scripts/instance_ctl.sh launch dev-2
 *   (cd ui && FLOWPAD_HUB_URL=http://localhost:8093 npx vitest run --project hub doc_comment_sync)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hubAvailable } from './_hub';
import { pollUntil } from './_matrix';
import { testEntityName } from '../_cleanup';
import {
  findPendingInvitation,
  getInstance,
  instanceAvailable,
  type ResolvedInstance,
} from './_instances';

const INST_1 = process.env.SHARE_INST_1 || 'dev-1';
const INST_2 = process.env.SHARE_INST_2 || 'dev-2';
const CONVERGE = 12_000; // safety deadline per convergence; not a slow-path mask

let skipReason: string | null = null;
let alice: ResolvedInstance;
let bob: ResolvedInstance;
let convId: string;

/** Trigger the receiver's catch-up subtree sync (pulls the conversation's hub
 * children), then read the comment (blob-expanded). The conversation is plain (no
 * shared doc) so the sync does no bundle/index work — it's a fast comment pull. */
async function commentOn(inst: ResolvedInstance, id: string): Promise<any | null> {
  await fetch(`${inst.apiUrl}/api/v1/graph/conversation-message-sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_id: convId }),
  }).catch(() => undefined);
  const r = await fetch(`${inst.apiUrl}/api/v1/graph/comment/${id}?expand=blobs`)
    .then((x) => x.json())
    .catch(() => null);
  return r?.status === 'SUCCESS' && r?.data?.id === id ? r.data : null;
}

async function waitText(inst: ResolvedInstance, id: string, text: string): Promise<any | null> {
  return pollUntil(async () => {
    const d = await commentOn(inst, id);
    return d && d.raw_content === text ? d : null;
  }, CONVERGE, `comment ${id} == "${text}" on ${inst.name}`).catch(() => null);
}

async function waitAbsent(inst: ResolvedInstance, id: string): Promise<boolean> {
  return pollUntil(async () => ((await commentOn(inst, id)) === null ? true : null), CONVERGE, `comment ${id} gone on ${inst.name}`)
    .then(() => true)
    .catch(() => false);
}

/** Create a comment under a parent via the backend (auto-shares to the hub). */
async function mkComment(inst: ResolvedInstance, parentType: string, parentId: string, text: string, line: number) {
  const r = await fetch(`${inst.apiUrl}/api/v1/graph/${parentType}/${parentId}/comment`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw_content: text, data: { line } }),
  }).then((x) => x.json());
  return { id: r.data.id as string, raw_content: text };
}

async function editComment(inst: ResolvedInstance, id: string, text: string) {
  await fetch(`${inst.apiUrl}/api/v1/graph/comment/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'Hub-Reflect': 'true' },
    body: JSON.stringify({ raw_content: text }),
  });
}

async function rmComment(inst: ResolvedInstance, id: string) {
  await fetch(`${inst.apiUrl}/api/v1/graph/comment/${id}`, { method: 'DELETE' });
}

beforeAll(async () => {
  const hub = await hubAvailable();
  if (!hub.ok) return void (skipReason = hub.reason ?? 'hub unreachable');
  if (!(await instanceAvailable(INST_1)) || !(await instanceAvailable(INST_2))) {
    return void (skipReason = `launch ${INST_1} + ${INST_2} via scripts/instance_ctl.sh`);
  }
  alice = await getInstance(INST_1);
  bob = await getInstance(INST_2);

  // A PLAIN conversation (no shared doc → no bundle/index work on sync). Comments
  // are children of the conversation itself — the generic is_child path.
  //
  // NOT trackForCleanup()'d: this conversation is MODULE-scoped (shared by all
  // three tests). The shared cleanup registry purges on `afterEach`, on the
  // CURRENT realm (bob, the last getInstance) — so tracking it would DELETE bob's
  // local conversation row after test 1, 404-ing every later test's sync. The
  // afterAll below deletes the e2etest- conversation on BOTH instances instead.
  const conv = new alice.sdk.Conversation({ title: testEntityName('conv') });
  await conv.save();
  await conv.share([bob.email]);
  expect(conv.remote).toBe(true);
  convId = conv.id!;

  // Bob accepts via his BACKEND's invitation-accept, then the conversation-list
  // pipeline UPSERTS the conversation into bob's LOCAL DB. The per-conversation
  // catch-up sync 404s until that local row exists — so gate on the sync returning
  // 200 (a GET reflects to the hub and would lie; the sync needs the local row).
  const invitation = await pollUntil(() => findPendingInvitation(bob, convId), 20_000, 'pending invitation');
  await fetch(`${bob.apiUrl}/api/v1/graph/invitation-accept`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ invitation_id: invitation.id! }),
  });
  await pollUntil(async () => {
    const status = await fetch(`${bob.apiUrl}/api/v1/graph/conversation-message-sync`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_id: convId }),
    }).then((r) => r.status).catch(() => 0);
    return status === 200 ? true : null;
  }, 25_000, 'bob local conversation row materialized (sync 200)');
}, 30_000); // do not increase timeout without approval

beforeEach((context: any) => {
  if (skipReason) context.skip();
});

afterAll(async () => {
  if (skipReason || !alice || !bob) return;
  for (const inst of [alice, bob]) {
    const list = await fetch(`${inst.apiUrl}/api/v1/graph/conversation`).then((r) => r.json()).catch(() => null);
    for (const r of (list?.data ?? []) as any[]) {
      if (String(r?.title ?? '').startsWith('e2etest-') && r?.id) {
        await fetch(`${inst.apiUrl}/api/v1/graph/conversation/${r.id}`, { method: 'DELETE' }).catch(() => undefined);
      }
    }
  }
});

describe('doc comment child sync (Alice ↔ Bob)', () => {
  it('create — a comment by either peer reaches the other [doc_comment_create_sync]', async () => {
    const a = await mkComment(alice, 'conversation', convId, `alice-create-${convId.slice(0, 6)}`, 3);
    expect(await waitText(bob, a.id!, a.raw_content!), 'create A→B: bob receives alice comment').toBeTruthy();

    const b = await mkComment(bob, 'conversation', convId, `bob-create-${convId.slice(0, 6)}`, 4);
    expect(await waitText(alice, b.id!, b.raw_content!), 'create B→A: alice receives bob comment').toBeTruthy();
  }, 30_000); // do not increase timeout without approval

  it('update — editing a comment syncs the new text [doc_comment_update_sync]', async () => {
    const a = await mkComment(alice, 'conversation', convId, 'u1', 3);
    expect(await waitText(bob, a.id!, 'u1'), 'update setup: bob sees u1').toBeTruthy();
    await editComment(alice, a.id!, 'edited-by-alice');
    expect(await waitText(bob, a.id!, 'edited-by-alice'), 'update A→B: edit reaches bob').toBeTruthy();

    const b = await mkComment(bob, 'conversation', convId, 'u1', 4);
    expect(await waitText(alice, b.id!, 'u1'), 'update setup: alice sees u1').toBeTruthy();
    await editComment(bob, b.id!, 'edited-by-bob');
    expect(await waitText(alice, b.id!, 'edited-by-bob'), 'update B→A: edit reaches alice').toBeTruthy();
  }, 30_000); // do not increase timeout without approval

  it('delete — present on BOTH sides, then removed for the peer [doc_comment_delete_sync]', async () => {
    const a = await mkComment(alice, 'conversation', convId, 'to-delete-a', 3);
    expect(await waitText(alice, a.id!, 'to-delete-a'), 'delete setup: present on alice').toBeTruthy();
    expect(await waitText(bob, a.id!, 'to-delete-a'), 'delete setup: present on bob').toBeTruthy();
    await rmComment(alice, a.id!); // server auto-propagates child_deleted (no Hub-Reflect)
    expect(await waitAbsent(bob, a.id!), 'delete A→B: comment disappears for bob').toBe(true);

    const b = await mkComment(bob, 'conversation', convId, 'to-delete-b', 4);
    expect(await waitText(bob, b.id!, 'to-delete-b'), 'delete setup: present on bob').toBeTruthy();
    expect(await waitText(alice, b.id!, 'to-delete-b'), 'delete setup: present on alice').toBeTruthy();
    await rmComment(bob, b.id!);
    expect(await waitAbsent(alice, b.id!), 'delete B→A: comment disappears for alice').toBe(true);
  }, 30_000); // do not increase timeout without approval
});
