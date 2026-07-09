/**
 * Shared rig for the generic entity-child (comment) live-sync browser matrix —
 * the Playwright tier of the 3-layer document-collaboration suite (pytest ·
 * vitest · browser). One conversation is shared alice↔bob through the local hub;
 * comments are children of that conversation (the generic `shared_child` path,
 * NOT a comment-specific route), so this exercises "sync entity children live"
 * end to end, both directions.
 *
 * TWO-INSTANCE rig (env-gated, skips otherwise — matching
 * two_instance_hub_conversation.md.ts): two SEPARATE backends, each cloud-logged
 * in as its own hub user, launched via scripts/instance_ctl.sh:
 *   - alice = QA_ALICE_API (default dev-5 backend :6005, hub user dev-5@local.test)
 *   - bob   = QA_BOB_API   (default dev-6 backend :6006, hub user dev-6@local.test)
 *   - hub   = QA_HUB_URL   (default http://localhost:8093)
 *
 * Comment CRUD goes through each instance's REAL backend (the same routes the
 * UI's use-doc-comments hook drives): create auto-shares to the hub, edit
 * reflects (Hub-Reflect), delete auto-propagates child_deleted. The receiver
 * pulls via conversation-message-sync (the catch-up the app runs on conversation
 * open) and reads the comment blob-expanded — exactly the vitest oracle, lifted
 * to the Playwright manual-regression tier.
 */
import { request as pwRequest, test, type APIRequestContext } from '@playwright/test';

export const HUB = process.env.QA_HUB_URL || 'http://localhost:8093';
export const ALICE_API = process.env.QA_ALICE_API || 'http://localhost:6005';
export const BOB_API = process.env.QA_BOB_API || 'http://localhost:6006';
export const ALICE_EMAIL = process.env.QA_ALICE_EMAIL || 'dev-5@local.test';
export const BOB_EMAIL = process.env.QA_BOB_EMAIL || 'dev-6@local.test';
export const BOB_PW = process.env.QA_BOB_PW || 'dev-6-pw-1234';
// Per-convergence safety deadline. NOT a slow-path mask — a healthy sync lands
// the child in one poll; this only bounds a stuck run. Do not raise (CLAUDE.md).
export const CONVERGE = 15_000;

/** Skip reason if the two-instance rig isn't reachable; null when good to go. */
export async function rigUnavailable(rq: APIRequestContext): Promise<string | null> {
  for (const [name, base] of [
    ['hub', `${HUB}/api/v1/login/test`],
    ['alice', `${ALICE_API}/api/v1/cloud/status`],
    ['bob', `${BOB_API}/api/v1/cloud/status`],
  ] as const) {
    const ok = await rq.get(base).then((r) => r.ok()).catch(() => false);
    if (!ok) return `${name} unreachable (${base}) — launch dev-5 + dev-6 via scripts/instance_ctl.sh and start the hub`;
  }
  return null;
}

async function json(rq: APIRequestContext, url: string, opts?: { method?: string; data?: unknown; headers?: Record<string, string> }) {
  const method = (opts?.method || 'GET').toUpperCase();
  const res = await rq.fetch(url, { method, data: opts?.data as object | undefined, headers: opts?.headers });
  return { status: res.status(), body: await res.json().catch(() => null) };
}

/** Generic poll: call `fn` until it returns a truthy value or CONVERGE elapses. */
async function pollUntil<T>(fn: () => Promise<T | null>, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 300));
  }
}

export interface Rig {
  rq: APIRequestContext;
  convId: string;
  bobToken: string;
}

/** Create a conversation on alice, share to bob, bob accepts, and gate on bob's
 *  per-conversation sync returning 200 (his local row materialized). */
export async function setupSharedConversation(rq: APIRequestContext): Promise<Rig> {
  const bobLogin = await json(rq, `${HUB}/api/v1/login`, { method: 'POST', data: { email: BOB_EMAIL, password: BOB_PW } });
  const bobToken: string = bobLogin.body?.data?.token;
  if (!bobToken) throw new Error('bob hub login failed — is dev-6@local.test seeded on the hub?');

  const conv = await json(rq, `${ALICE_API}/api/v1/graph/conversation`, { method: 'POST', data: { title: `e2etest-collab-${Date.now()}` } });
  const convId: string = conv.body?.data?.id;
  if (!convId) throw new Error('alice conversation create failed');
  await json(rq, `${ALICE_API}/api/v1/graph/conversation/${convId}/share`, { method: 'POST', data: { ...conv.body.data, recipients: [BOB_EMAIL] } });

  // bob finds the pending invitation (hub-direct) and accepts via his backend.
  // Match the EMBEDDED conversation id precisely — same rule as
  // ui/tests/hub/_matrix.ts pickPendingInvitation. A loose substring match would
  // pick the wrong invitation when stale/concurrent ones share the recipient.
  const invitation = await pollUntil(async () => {
    const pending = await json(rq, `${HUB}/api/v1/graph/invitation/pending`, { headers: { Authorization: `Bearer ${bobToken}` } });
    return (pending.body?.data ?? []).find(
      (inv: { id: string; accepted?: boolean; conversation?: { id?: string }; conversation_id?: string; target_url_path?: string }) =>
        !inv.accepted && ((inv.conversation?.id ?? inv.conversation_id) === convId || (inv.target_url_path || '').includes(convId)),
    ) ?? null;
  }, 15_000);
  if (!invitation) throw new Error('bob never received the conversation invitation');
  await json(rq, `${BOB_API}/api/v1/graph/invitation-accept`, { method: 'POST', data: { invitation_id: invitation.id } });

  // Gate on bob's per-conversation sync returning 200 (local row exists).
  const synced = await pollUntil(async () => {
    const s = await json(rq, `${BOB_API}/api/v1/graph/conversation-message-sync`, { method: 'POST', data: { conversation_id: convId } });
    return s.status === 200 ? true : null;
  }, 25_000);
  if (!synced) throw new Error('bob local conversation row never materialized (sync 200)');
  return { rq, convId, bobToken };
}

/** Create a comment under the conversation via an instance backend (auto-shares). */
export async function mkComment(rq: APIRequestContext, api: string, convId: string, text: string, line: number): Promise<string> {
  const r = await json(rq, `${api}/api/v1/graph/conversation/${convId}/comment`, { method: 'POST', data: { raw_content: text, data: { line } } });
  const id = r.body?.data?.id;
  if (!id) throw new Error(`comment create failed on ${api}: ${JSON.stringify(r.body)}`);
  return id;
}

export async function editComment(rq: APIRequestContext, api: string, id: string, text: string): Promise<void> {
  await json(rq, `${api}/api/v1/graph/comment/${id}`, { method: 'PUT', data: { raw_content: text }, headers: { 'Hub-Reflect': 'true' } });
}

export async function rmComment(rq: APIRequestContext, api: string, id: string): Promise<void> {
  await json(rq, `${api}/api/v1/graph/comment/${id}`, { method: 'DELETE' });
}

/** Trigger the receiver's catch-up sync, then read the comment (blob-expanded). */
async function syncAndRead(rq: APIRequestContext, api: string, convId: string, id: string) {
  await json(rq, `${api}/api/v1/graph/conversation-message-sync`, { method: 'POST', data: { conversation_id: convId } });
  const r = await json(rq, `${api}/api/v1/graph/comment/${id}?expand=blobs`);
  return r.status === 200 && r.body?.data?.id === id ? r.body.data : null;
}

/** Poll the receiver until the comment reads as `text` (returns it) or times out. */
export async function waitText(rq: APIRequestContext, api: string, convId: string, id: string, text: string): Promise<unknown> {
  return pollUntil(async () => {
    const d = await syncAndRead(rq, api, convId, id);
    return d && (d as { raw_content?: string }).raw_content === text ? d : null;
  }, CONVERGE);
}

/** Poll the receiver until the comment is gone (returns true) or times out. */
export async function waitAbsent(rq: APIRequestContext, api: string, convId: string, id: string): Promise<boolean> {
  return (await pollUntil(async () => ((await syncAndRead(rq, api, convId, id)) === null ? true : null), CONVERGE)) === true;
}

/** Best-effort teardown: delete the shared e2etest- conversation on both backends. */
async function cleanup(rq: APIRequestContext, convId: string): Promise<void> {
  for (const api of [ALICE_API, BOB_API]) {
    await json(rq, `${api}/api/v1/graph/conversation/${convId}`, { method: 'DELETE' }).catch(() => undefined);
  }
}

/** Test-body wrapper owning the whole rig lifecycle: request context, skip-guard,
 *  shared-conversation setup, and guaranteed teardown + dispose. Each scenario
 *  file supplies only its assertions. */
export function withSharedConversation(body: (rq: APIRequestContext, rig: Rig) => Promise<void>): () => Promise<void> {
  return async () => {
    test.setTimeout(60_000);
    const rq = await pwRequest.newContext();
    const skip = await rigUnavailable(rq);
    test.skip(!!skip, skip ?? '');
    let rig: Rig | undefined;
    try {
      rig = await setupSharedConversation(rq);
      await body(rq, rig);
    } finally {
      if (rig) await cleanup(rq, rig.convId);
      await rq.dispose();
    }
  };
}
