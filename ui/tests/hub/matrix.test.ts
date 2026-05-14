/**
 * TS mirror of ``tests/hub_tests/test_message_matrix.py``.
 *
 * Single-process, alice-as-SDK + bob-as-raw-hub:
 *   - Cell 1:  alice sends "cell-1-http" via SDK ``conv.addMessage``.
 *   - Cell 2:  bob's raw hub WS sees the ``data_op_msg(create)`` frame;
 *              alice's SDK ``conv.on('message', cb)`` tap also fires.
 *   - Cell 2b: bob acks via raw POSTs to ``/flow_message/mark_delivered``
 *              and ``/mark_received``; alice (sender) observes both
 *              ``data_op_msg(update)`` fanouts via
 *              ``ConnectionManager.on('on_data_op', ...)``.
 *
 * Body upload/download is intentionally not duplicated here —
 * ``body_upload_download.test.ts`` already covers the body lifecycle.
 *
 * Prereqs (mirrors pytest matrix):
 *   - Local hub on :8093.
 *   - Local flowpad backend (alice side) cloud-logged-in as alice@local.test.
 *   - bob's creds in the ``REPO_APP`` sibling repo's ``.env.local``.
 */

// SDK imports: config exposes SERVER_URL of the local backend; ConnectionManager
// is the singleton that owns the WebSocket to the local backend; dataContext is
// imported for its side-effects (registry init) — touching it at the end of the
// test keeps tree-shakers from dropping it.
import { config, ConnectionManager, dataContext } from '@sdk';

// Conversation is the production entity class — same one the UI uses to
// create/share convs and post messages.
import { Conversation } from '@sdk/entities/conversation';

// FlowMessage class — needed to wrap a raw FM data object so we can call
// ``uploadBody()`` on it (the body-upload helper lives on the class).
import { FlowMessage, type IFlowMessage } from '@sdk/entities/flow-message';

// Standard vitest hooks/matchers.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

// jsdom's built-in WebSocket only accepts a ``protocols`` string in arg 2 — it
// ignores ``{ headers }`` and crashes when you try. The hub auths WS via the
// ``Authorization`` header, so we use Node's ``ws`` lib (already in
// ui/node_modules transitively) to give bob (and alice's raw socket) a real,
// header-capable socket.
import { WebSocket as NodeWS } from 'ws';

// Used by cell 7's bundle validation: write the downloaded .flowmsg to /tmp
// and shell out to macOS ``unzip -p`` to read header.json (no zip lib in
// node_modules so we lean on the system CLI).
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// apiTestSetup signs the test process into the local backend as a throwaway
// "tester" identity; the cloud-logged-in alice creds layered on top let us
// reach the hub. getTestSignupInfo just returns a stable email/password pair.
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

// HUB_URL = http://localhost:8093 (default), getAliceCreds/getBobCreds parse
// .env.local from REPO_OSS / REPO_APP, hubLogin POSTs /api/v1/login.
import { HUB_URL, getAliceCreds, getBobCreds, hubLogin } from './_hub';

// _hub.ts's hubAvailable() uses AbortSignal.timeout(...) which jsdom's fetch
// rejects with a TypeError. We need this check, so re-implement it inline
// without AbortSignal so it works in the jsdom env.
async function probeHub(): Promise<{ ok: boolean; reason?: string }> {
  // Just a quick health GET — if hub is up and on the right port, 200 OK.
  try {
    const r = await fetch(`${HUB_URL}/api/v1/health/status`);
    if (!r.ok) return { ok: false, reason: `hub /health returned ${r.status}` };
    return { ok: true };
  } catch (e) {
    // Connection refused / DNS fail / etc. → hub unreachable.
    return { ok: false, reason: `hub unreachable: ${String(e)}` };
  }
}

// Same workaround for the local-backend cloud-status check (also uses
// AbortSignal.timeout in _hub.ts). Without this, the SDK has no cloud creds
// and the hub call from inside addMessage/share would 401.
async function probeLocalBackendLoggedIn(apiBase: string): Promise<boolean> {
  try {
    const r = await fetch(`${apiBase}/cloud/status`);
    if (!r.ok) return false;
    // Backend returns {data: {logged_in: true|false, user: {...}}}.
    const body = (await r.json()) as { data?: { logged_in?: boolean } };
    return body.data?.logged_in === true;
  } catch {
    return false;
  }
}

// Module-scope state populated by beforeAll. If any prereq fails, ``skipReason``
// is set and beforeEach skips every ``it`` with that reason.
let skipReason: string | null = null;
let aliceToken: string | null = null;     // hub bearer token for alice (unused directly — alice goes via SDK)
let aliceUserId: string | null = null;    // used to assert ``sender_id`` on bob's incoming frame
let bobToken: string | null = null;       // bob's hub bearer token — used for raw WS + raw REST acks
let bobEmail: string | null = null;       // used to find the right invitation in bob's pending list

beforeAll(async () => {
  // 1. Is the hub up? If not, nothing else will work — skip.
  const hub = await probeHub();
  if (!hub.ok) {
    skipReason = hub.reason ?? 'hub unreachable';
    console.log('[matrix] skip:', skipReason);
    return;
  }

  // 2. Is alice's local backend cloud-logged-in? The SDK posts go
  //    local-backend → hub; without cloud creds the backend can't authenticate
  //    to the hub.
  if (!(await probeLocalBackendLoggedIn(config.SERVER_URL))) {
    skipReason = `local backend (${config.SERVER_URL}) is not cloud-logged-in`;
    console.log('[matrix] skip:', skipReason);
    return;
  }

  // 3. Pull email/password pairs from the two .env.local files. alice = this
  //    repo (REPO_OSS), bob = sibling REPO_APP.
  const alice = await getAliceCreds();
  const bob = await getBobCreds();
  if (!alice || !bob) {
    skipReason = `missing creds — alice=${!!alice} bob=${!!bob}`;
    console.log('[matrix] skip:', skipReason);
    return;
  }

  // 4. Direct hub login for both users — we need bob's bearer token for the
  //    raw WS / raw mark_* POSTs, and we want alice's user_id to assert
  //    ``sender_id`` on the create-frame bob receives.
  const aliceLogin = await hubLogin(alice.email, alice.password);
  const bobLogin = await hubLogin(bob.email, bob.password);
  aliceToken = aliceLogin.token;
  aliceUserId = aliceLogin.user.id;
  bobToken = bobLogin.token;
  bobEmail = bob.email;
  // Visible ready-line in vitest stdout so you can confirm both users
  // resolved before the test body runs.
  console.log(`[matrix] ready: alice=${aliceUserId?.slice(0, 8)} bob=${bobLogin.user.id?.slice(0, 8)}`);
});

// Stable signup info reused across tests in this file (only one here, but the
// pattern matches the other hub vitests).
const signupInfo = getTestSignupInfo();

beforeEach(async (context: any) => {
  // If anything in beforeAll failed, mark each ``it`` as skipped — vitest
  // doesn't have a beforeAll-level skip, so we propagate via beforeEach.
  if (skipReason) context.skip();
  // Sign the test process into the LOCAL backend as a fresh test user so
  // SDK calls (Conversation.save, addMessage, etc.) succeed. Independent of
  // cloud login — local identity ≠ hub identity, the backend bridges them.
  await apiTestSetup(signupInfo, context.task.name);
});

// ── Helpers ────────────────────────────────────────────────────────────────

// Headers used for every raw hub call we make AS BOB (his WS upgrade, his
// invitation accept, his mark_delivered / mark_received).
function bobHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${bobToken}`, 'Content-Type': 'application/json' };
}

// After alice's ``conv.share([bobEmail])``, bob has an invitation row pending
// on the hub. Real desktop bob would call /accept + /join via his client; in
// this single-process test we simulate it inline with raw fetches.
async function bobAcceptAndJoin(convId: string): Promise<void> {
  // List every pending invitation addressed to bob.
  const pendingResp = await fetch(`${HUB_URL}/api/v1/graph/invitation/pending`, {
    headers: bobHeaders(),
  });
  if (!pendingResp.ok) throw new Error(`pending invitations: ${pendingResp.status}`);
  const pending = ((await pendingResp.json()) as { data: any[] }).data ?? [];

  // Find the one we just created. Filtering on email + not-yet-accepted, then
  // sorting by created_date descending guards against stale invitations
  // from earlier test runs (this can happen when the hub DB isn't wiped
  // between runs).
  const matching = pending
    .filter((p) => p?.recipient_email === bobEmail && !p?.accepted)
    .sort((a, b) =>
      String(b?.created_date ?? '').localeCompare(String(a?.created_date ?? '')),
    );
  const inv = matching[0];
  if (!inv) throw new Error(`no pending invitation for ${bobEmail}: got ${JSON.stringify(pending)}`);

  // Step 1 of the accept-flow: claim the invitation (flips ``accepted=true``).
  const acceptResp = await fetch(
    `${HUB_URL}/api/v1/graph/members/accept?invitation-id=${inv.id}`,
    { headers: bobHeaders() },
  );
  if (!acceptResp.ok) throw new Error(`accept: ${acceptResp.status} ${await acceptResp.text()}`);

  // Step 2: actually join the conversation. Until this, bob isn't a member
  // and the hub won't fanout the conv's messages to his WS.
  const joinResp = await fetch(`${HUB_URL}/api/v1/graph/conversation/${convId}/join`, {
    method: 'POST',
    headers: bobHeaders(),
    body: '{}',
  });
  if (!joinResp.ok) throw new Error(`join: ${joinResp.status} ${await joinResp.text()}`);
}

// Bag of events captured from a raw hub WS + handles to close it and to
// send frames. ``ready`` resolves once the upgrade handshake completes so
// the test won't send before the socket is actually subscribed.
interface HubObserver {
  events: any[];
  send: (frame: object) => void;
  close: () => void;
  ready: Promise<void>;
}

// Opens a raw WebSocket to the hub authenticated with the given bearer token,
// and pushes every JSON frame into an in-memory array. Used for bob (so we can
// observe his fanout) and for alice (so she can SEND via WS).
function openHubWs(token: string): HubObserver {
  // Convert http://… → ws://… (or https://… → wss://…), then append the
  // hub's WS route with a random connection-id (the hub uses this as the
  // Connection entity's primary key).
  const wsUrl =
    HUB_URL.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:') +
    `/api/v1/connect/ws/${crypto.randomUUID()}`;

  // Mutable array — the test reads from this; the WS pushes into it.
  const events: any[] = [];

  // Open the socket. Node's ``ws`` lib supports a 2nd-arg options object,
  // so we can pass Authorization here (jsdom's WebSocket can't).
  const ws = new NodeWS(wsUrl, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });

  // ``ready`` resolves on 'open' (handshake done, frames are flowing) or
  // rejects on early 'error'. Tests await this before sending so we don't
  // miss the create frame for our own send.
  const ready = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (err) => reject(new Error(`hub WS error: ${String(err)}`)));
  });

  // Every text frame from the hub is JSON. Parse + push; tolerate the
  // occasional non-JSON keepalive without crashing the test.
  ws.on('message', (raw) => {
    try {
      events.push(JSON.parse(raw.toString()));
    } catch {
      // non-JSON frame — ignore
    }
  });

  // ``send`` JSON-stringifies the frame and ships it as a text WS message.
  // The hub interprets ``message_type: 'rest_api_msg'`` frames as proxied
  // REST actions (same as the local flowpad backend's hub-bridge does).
  return { events, send: (frame) => ws.send(JSON.stringify(frame)), close: () => ws.close(), ready };
}

// WS-send helper: posts an ``add_message`` action over an open hub WS by
// wrapping the body in the hub's ``rest_api_msg`` envelope. Returns the
// new FM's id by waiting for the create-fanout frame on ``observer`` (we
// don't need to parse a separate response_msg because the sender is a conv
// participant and the fanout reaches their own socket).
async function wsAddMessage(
  observer: HubObserver,
  convId: string,
  text: string,
  attachment: Array<Record<string, unknown>> = [],
): Promise<string> {
  // The frame shape mirrors the hub-bridge envelope (see hub_bridge.py
  // ~lines 292–300). ``target_typeid`` says which entity the action runs on;
  // ``action: 'add_message'`` is the same handler hit by POST add_message.
  observer.send({
    message_id: crypto.randomUUID(),
    message_type: 'rest_api_msg',
    method: 'POST',
    scope: [],
    target_typeid: { type: 'conversation', id: convId },
    action: 'add_message',
    body: { text, ...(attachment.length > 0 ? { attachment } : {}) },
  });

  // Wait for the create-fanout frame for this very text. Since the sender
  // is a participant, the hub fanout lands on their own socket and gives us
  // the new FM id without a separate response_msg parse.
  //
  // We match by text only (no conv-id check): WS-routed creates don't carry
  // ``from_entity`` (HTTP-routed creates do — observed quirk), and the FM's
  // ``data`` payload doesn't carry ``conversation_id`` either. Text is
  // unique within the test conv so it's a safe predicate.
  const created = await waitFor(
    observer.events,
    (e: any) =>
      e?.message_type === 'data_op_msg' &&
      e.op === 'create' &&
      typeof e.to_entity === 'string' &&
      e.to_entity.startsWith('flow_message-') &&
      e.data?.text === text,
    5000,
    `WS-add_message create for "${text}"`,
  );
  return created.data.id as string;
}

// Bob fetches the FM record off the hub by id. Used after alice's skill
// sends to learn ``attachment_filename`` (needed to download the bundle).
async function bobHubGetFm(fmId: string): Promise<any> {
  const r = await fetch(`${HUB_URL}/api/v1/graph/flow_message/${fmId}`, {
    headers: bobHeaders(),
  });
  if (!r.ok) throw new Error(`bob GET fm ${fmId}: ${r.status} ${await r.text()}`);
  return (await r.json()).data;
}

// Polling wait: scan ``arr`` until ``predicate`` finds a match or we hit
// ``timeoutMs``. Useful when the thing we're waiting for is buffered into an
// array (vs. a one-shot promise).
async function waitFor<T>(
  arr: T[],
  predicate: (e: T) => boolean,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // ``find`` walks the WHOLE array every tick — a fanout frame that landed
    // before the wait started will still match.
    const hit = arr.find(predicate);
    if (hit) return hit;
    // 30ms tick — small enough to feel instant in human terms, large enough
    // to not pin a CPU.
    await new Promise((r) => setTimeout(r, 30));
  }
  // Throw a labelled error so a flaky timeout is easy to diagnose in the
  // vitest output.
  throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms (have ${arr.length} items)`);
}

// ── Test ──────────────────────────────────────────────────────────────────

describe('hub: FlowMessage matrix (alice SDK + bob raw + acks)', () => {
  it('alice sends → bob receives → bob acks → alice sees delivered + received fanout', async () => {
    // ── Open observers BEFORE any sends so create frames aren't missed.
    // Bob observer = his raw hub WS (auth via Authorization header).
    const bobObs = openHubWs(bobToken!);
    // Alice observer = her own raw hub WS, used in cell 5 to send via WS.
    // She still has the SDK's hub bridge for normal receive, but for SEND-via-WS
    // we need a socket she owns directly.
    const aliceObs = openHubWs(aliceToken!);
    // Wait for both handshakes before any send.
    await bobObs.ready;
    await aliceObs.ready;

    // Alice's "WebSocket" is the SDK's singleton ConnectionManager, which is
    // already connected to the local backend (which is already bridged to the
    // hub). We tap its on_data_op channel to catch UPDATE frames — the
    // higher-level ``conv.on('message')`` API only fires on CREATE.
    const cm = ConnectionManager.getInstance();

    // Bucket for every flow_message UPDATE frame alice receives. Acks emit
    // UPDATEs; that's what we'll assert on.
    const aliceUpdates: { typeIdStr: string; op: string; data: any }[] = [];

    // The tap: filter for op='update' on a flow_message-* entity, push the
    // raw payload. Reusing the same handler for off() so it's actually
    // detached on teardown.
    const aliceUpdateTap = (typeIdStr: string, op: string, data: any) => {
      if (op !== 'update') return;
      if (typeof typeIdStr !== 'string' || !typeIdStr.startsWith('flow_message-')) return;
      aliceUpdates.push({ typeIdStr, op, data });
    };
    cm.on('on_data_op', aliceUpdateTap);

    try {
      // ── Conv setup: alice creates + shares via SDK; bob accepts via raw hub.

      // New local conversation entity — id is generated client-side. Title is
      // timestamped to avoid clashes across runs.
      const conv = new Conversation({ title: `matrix-${Date.now()}` });

      // .save() persists it on the local backend. Still local-only; no hub
      // mirror yet, no membership.
      await conv.save();

      // .share() POSTs to the local backend's share action, which forwards
      // to the hub: mirrors the conv into the hub graph + invites bob.
      await conv.share([bobEmail!]);

      // conv.remote flips to true once share succeeds — it's the SDK's way
      // of saying "this conv now has a hub-side counterpart".
      expect(conv.remote).toBe(true);

      // Bob (simulated) walks the same accept→join chain the desktop client
      // would. After this returns he's a real participant; hub will fanout
      // the conv's messages to his WS.
      await bobAcceptAndJoin(conv.id);

      // Bucket for messages alice's SDK observes on this conv. The SDK fires
      // 'message' for every CREATE on this conversation — including alice's
      // own sends (because the hub fanout is symmetric).
      const aliceCreates: IFlowMessage[] = [];

      // Production-style listener. Returns an unsubscribe function we'll
      // call to clean up later.
      const offCreate = conv.on('message', (m: IFlowMessage) => {
        aliceCreates.push(m);
      });

      // ── Cell 1: alice sends via SDK ────────────────────────────────────

      // The actual production code path: POST add_message via the local
      // backend, which forwards to the hub. Returns the persisted FM with
      // its hub-issued id.
      const fm = await conv.addMessage('cell-1-http');

      // Basic shape checks before observers verify fanout — these would fail
      // fast if add_message returned an empty/odd response.
      expect(fm.id).toBeTruthy();
      expect(fm.text).toBe('cell-1-http');

      // ── Cell 2: bob's raw WS sees the create frame ─────────────────────

      // Poll bob's event queue for the matching ``data_op_msg(create)`` frame.
      // The 4-field predicate makes sure we're matching the right kind of
      // frame on the right entity-type with the right id (not, say, a
      // member-create or a conv-update that happened to land first).
      const createFrame = await waitFor(
        bobObs.events,
        (e: any) =>
          e?.message_type === 'data_op_msg' &&
          e.op === 'create' &&
          typeof e.to_entity === 'string' &&
          e.to_entity.startsWith('flow_message-') &&
          e.data?.id === fm.id,
        5000,
        'bob WS create for fm',
      );

      // The payload bob receives should carry alice's text + her user_id —
      // proves the hub didn't reshape or strip the FM en route.
      expect(createFrame.data.text).toBe('cell-1-http');
      expect(createFrame.data.sender_id).toBe(aliceUserId);

      // Alice's own SDK should also see the create (her own send fans back
      // to her). Then we detach the tap before moving on.
      await waitFor(aliceCreates, (m) => m.id === fm.id, 2000, 'alice SDK on("message")');
      offCreate();

      // ── Cell 2b: ack lifecycle ─────────────────────────────────────────

      // Step 1 of the ack lifecycle: bob tells the hub "I have this in my
      // device's inbox". Hub flips delivery_status: created → delivered and
      // stamps delivered_at.
      const delivResp = await fetch(`${HUB_URL}/api/v1/graph/flow_message/mark_delivered`, {
        method: 'POST',
        headers: bobHeaders(),
        body: JSON.stringify({ flow_message_ids: [fm.id] }),
      });

      // Confirm the hub accepted the request — 200 + body says exactly which
      // FMs got their status bumped.
      expect(delivResp.status).toBe(200);
      const delivBody = ((await delivResp.json()) as { data: { updated: string[] } }).data;
      expect(delivBody.updated).toEqual([fm.id]);

      // Wait for the fanout: hub broadcasts a flow_message UPDATE to every
      // conv participant — alice (the sender) is one of them. ``aliceUpdates``
      // is fed by the tap we installed at the top.
      const delivUpd = await waitFor(
        aliceUpdates,
        (u) => u.data?.id === fm.id && u.data?.delivery_status === 'delivered',
        5000,
        'alice update(delivered)',
      );

      // Two invariants on the delivered frame: timestamp is set, and we
      // haven't accidentally jumped past the 'delivered' state into
      // 'received' yet.
      expect(delivUpd.data.delivered_at).toBeTruthy();
      expect(delivUpd.data.received_at ?? null).toBeNull();

      // Step 2 of the ack lifecycle: bob tells the hub "I've now READ this
      // message" (e.g. opened the conv). Flips delivery_status to 'received'
      // and stamps received_at.
      const recvResp = await fetch(`${HUB_URL}/api/v1/graph/flow_message/mark_received`, {
        method: 'POST',
        headers: bobHeaders(),
        body: JSON.stringify({ flow_message_ids: [fm.id] }),
      });

      // Same response-shape check as above.
      expect(recvResp.status).toBe(200);
      const recvBody = ((await recvResp.json()) as { data: { updated: string[] } }).data;
      expect(recvBody.updated).toEqual([fm.id]);

      // Second fanout: alice's WS should see another UPDATE with the new
      // delivery_status = 'received'. Same waitFor, different predicate.
      const recvUpd = await waitFor(
        aliceUpdates,
        (u) => u.data?.id === fm.id && u.data?.delivery_status === 'received',
        5000,
        'alice update(received)',
      );

      // Final invariant on the received frame: timestamp is now set.
      expect(recvUpd.data.received_at).toBeTruthy();

      // ── Cell 3: bob WS-replies to alice's first msg ─────────────────────
      // Re-install alice's SDK 'message' tap so we can observe bob's reply
      // arriving via the SDK channel (we detached it after cell 2's check).
      const aliceCreates2: IFlowMessage[] = [];
      const offCreate2 = conv.on('message', (m: IFlowMessage) => {
        aliceCreates2.push(m);
      });

      // Bob sends "cell-3-bob-ws-reply" over his existing raw WS as an
      // ``add_message`` action. The helper returns the new FM id once bob's
      // own WS sees the create fanout.
      const bobReplyFmId = await wsAddMessage(bobObs, conv.id, 'cell-3-bob-ws-reply');
      expect(bobReplyFmId).toBeTruthy();

      // Alice's production SDK on('message') tap should catch the reply.
      // This proves the round-trip: bob WS-sent → hub fanned out → alice's
      // local-backend WS bridge → SDK ConnectionManager → conv.on('message').
      const aliceSawReply = await waitFor(
        aliceCreates2,
        (m) => m.id === bobReplyFmId,
        5000,
        'alice SDK sees bob WS reply',
      );
      expect(aliceSawReply.text).toBe('cell-3-bob-ws-reply');
      offCreate2();

      // ── Cell 3b: auto-ack — alice's bridge marks bob's reply as delivered.
      // Production behavior: alice's local-backend hub-bridge sees bob's
      // flow_message-create on its hub WS, notices the sender isn't alice,
      // and fire-and-forgets ``mark_delivered`` on the hub. The hub then
      // fans an UPDATE frame to all participants — bob's raw WS should see
      // ``delivery_status='delivered'`` on his own FM with NO mark_delivered
      // POST coming from the test.
      const autoDeliveredReply = await waitFor(
        bobObs.events,
        (e: any) =>
          e?.message_type === 'data_op_msg' &&
          e.op === 'update' &&
          typeof e.to_entity === 'string' &&
          e.to_entity.startsWith('flow_message-') &&
          e.data?.id === bobReplyFmId &&
          e.data?.delivery_status === 'delivered',
        5000,
        'auto-ack(delivered) for bob reply',
      );
      expect(autoDeliveredReply.data.delivered_at).toBeTruthy();

      // ── Cell 4: alice sends a skill via REST (SDK) ──────────────────────
      // The skill attachment uses a stable fake id — the local backend packs
      // whatever's at that ``skill-<id>`` typeid into the bundle; for our
      // test we just need a TYPE_ID attachment to flip body_status to
      // UPLOADING so we exercise the body lifecycle.
      const SKILL_ID = 'skill-deadbeef-0000-0000-0000-000000000001';

      // Pick a deterministic text so cell 7's validation can compare it.
      const skillRestText = 'cell-4-skill-rest';

      // SDK addMessage with the TYPE_ID attachment. Hub returns the FM with
      // body_status='uploading' because has_body() is true on the server.
      const skillRestData = (await conv.addMessage(skillRestText, {
        attachment: [{ attachment_type: 'type_id', data: SKILL_ID }],
      })) as IFlowMessage;
      expect(skillRestData.id).toBeTruthy();
      expect(skillRestData.body_status).toBe('uploading');

      // Wrap in a FlowMessage instance so we can call ``uploadBody()`` — that
      // method drives the pack-and-upload pipeline on alice's local backend
      // (which in turn POSTs the .flowmsg zip to the hub).
      const fmSkillRest = new FlowMessage(skillRestData);
      await fmSkillRest.uploadBody();

      // After upload, the hub FM should be ready + carry the bundle's
      // filename so bob can request it in cell 7.
      const restOnHub = await bobHubGetFm(fmSkillRest.id!);
      expect(restOnHub.body_status).toBe('ready');
      expect(restOnHub.attachment_filename).toBeTruthy();

      // Bob's WS should also have seen the create fanout for this FM.
      await waitFor(
        bobObs.events,
        (e: any) =>
          e?.message_type === 'data_op_msg' &&
          e.op === 'create' &&
          e.data?.id === fmSkillRest.id,
        5000,
        'bob WS create for skill-rest FM',
      );

      // ── Cell 5: alice sends a skill header via WS (raw) ─────────────────
      // Same skill TYPE_ID, but the create POST goes over alice's raw hub WS.
      // Cell 4's path was REST through her SDK + local backend; this proves
      // the WS transport produces an equivalent hub-side header create.
      //
      // We deliberately stop after the header create here: the body upload
      // for a raw-WS-sent FM would require a fully-wired bridge (the SDK's
      // ``uploadBody`` helper assumes the FM originated through the local
      // backend so it can resolve the on-disk attachment). Cell 4's
      // REST-sent FM is the one cell 7 downloads + validates.
      const skillWsText = 'cell-5-skill-ws';
      const fmSkillWsId = await wsAddMessage(aliceObs, conv.id, skillWsText, [
        { attachment_type: 'type_id', data: SKILL_ID },
      ]);
      expect(fmSkillWsId).toBeTruthy();

      // Verify hub recorded the header with the right state for an
      // attachment-bearing FM whose body hasn't uploaded yet.
      const wsOnHub = await bobHubGetFm(fmSkillWsId);
      expect(wsOnHub.body_status).toBe('uploading');
      expect(Array.isArray(wsOnHub.attachment)).toBe(true);
      expect(wsOnHub.attachment[0]?.data).toBe(SKILL_ID);

      // Bob's WS sees the WS-sent create too — proves the hub's fanout
      // doesn't care which transport originated the create.
      await waitFor(
        bobObs.events,
        (e: any) =>
          e?.message_type === 'data_op_msg' &&
          e.op === 'create' &&
          e.data?.id === fmSkillWsId,
        5000,
        'bob WS create for skill-ws FM',
      );

      // ── Cell 6: bob WS-replies "thanks" ─────────────────────────────────
      // Mirrors cell 3 but with a different text. Verifies the WS-send path
      // still works late in the test, after acks + skill upload churn.
      const aliceCreates3: IFlowMessage[] = [];
      const offCreate3 = conv.on('message', (m: IFlowMessage) => {
        aliceCreates3.push(m);
      });
      const thanksFmId = await wsAddMessage(bobObs, conv.id, 'thanks');
      const aliceSawThanks = await waitFor(
        aliceCreates3,
        (m) => m.id === thanksFmId,
        5000,
        'alice SDK sees bob "thanks"',
      );
      expect(aliceSawThanks.text).toBe('thanks');
      offCreate3();

      // ── Cell 6b: auto-ack — alice's bridge marks "thanks" delivered too.
      // Same auto-ack path as cell 3b, just on the second WS-replied FM.
      // Repeated late in the test to prove the auto-ack works for every
      // inbound WS-sent FM, not just the first.
      const autoDeliveredThanks = await waitFor(
        bobObs.events,
        (e: any) =>
          e?.message_type === 'data_op_msg' &&
          e.op === 'update' &&
          typeof e.to_entity === 'string' &&
          e.to_entity.startsWith('flow_message-') &&
          e.data?.id === thanksFmId &&
          e.data?.delivery_status === 'delivered',
        5000,
        'auto-ack(delivered) for thanks',
      );
      expect(autoDeliveredThanks.data.delivered_at).toBeTruthy();

      // ── Cell 7: bob downloads + validates the skill bundle via REST ─────
      // Bob fetches the .flowmsg bundle for the REST-sent skill (cell 4)
      // straight from the hub's blob-download URL using his bearer token.
      const dlUrl = `${HUB_URL}/api/v1/graph/flow_message/${fmSkillRest.id}/fs/download/${restOnHub.attachment_filename}`;
      const dlResp = await fetch(dlUrl, { headers: bobHeaders() });
      expect(dlResp.status).toBe(200);

      // Convert to bytes and confirm it's actually a ZIP file (magic
      // ``PK\x03\x04``) — guards against the hub returning HTML or empty.
      const bytes = new Uint8Array(await dlResp.arrayBuffer());
      expect(bytes.length).toBeGreaterThan(100);
      expect(bytes[0]).toBe(0x50);
      expect(bytes[1]).toBe(0x4b);
      expect(bytes[2]).toBe(0x03);
      expect(bytes[3]).toBe(0x04);

      // Write to a temp file, then shell out to ``unzip -p`` to read
      // header.json (no zip lib in ui/node_modules so we use the OS unzip).
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-'));
      const tmpZip = path.join(tmpDir, 'bundle.flowmsg');
      fs.writeFileSync(tmpZip, bytes);

      // ``unzip -p <zip> header.json`` writes the file contents to stdout
      // without any extraction directory state — clean for our parse.
      const headerRaw = execFileSync('unzip', ['-p', tmpZip, 'header.json']).toString();
      const header = JSON.parse(headerRaw);

      // Validation: prove the bundle bob downloaded faithfully carries the
      // text and skill attachment alice authored. Round-trip is complete.
      expect(header.text).toBe(skillRestText);
      expect(Array.isArray(header.attachment)).toBe(true);
      expect(header.attachment[0]?.data).toBe(SKILL_ID);

      // Tidy up the temp dir — vitest pool runs single-threaded but we
      // shouldn't leak artifacts across re-runs.
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } finally {
      // Clean up regardless of pass/fail — leaving the tap or WS attached
      // would leak into the next test's environment.
      cm.off('on_data_op', aliceUpdateTap);
      bobObs.close();
      aliceObs.close();
    }

    // Touch dataContext so the SDK side-effect import isn't tree-shaken
    // away — same trick the other hub vitests use.
    void dataContext;
  });
});
