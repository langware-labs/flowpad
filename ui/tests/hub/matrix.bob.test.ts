/**
 * BOB side of the two-process matrix test. Companion: ``matrix.alice.test.ts``.
 *
 * Runs as its own vitest process against bob's own local backend (:9007).
 * Bob drives the real production SDK — no simulation: he lists his real
 * invitations, accepts through the real accept-flow, loads the materialized
 * conversation, and exchanges messages + a skill bundle with alice.
 *
 * Scenario (bob's half):
 *   1. Read the conv id alice published to the rendezvous file.
 *   2. Find the matching pending invitation; accept it (auto-joins).
 *   3. Load the Conversation; send "bob-joined" handshake.
 *   4. Wait for alice's "hi-from-alice"; mark it received; reply "hi-from-bob".
 *   5. Wait for alice's skill message; download + validate the bundle;
 *      mark it received.
 *   6. Send "thanks".
 *
 * Run: from bob's checkout —
 *   cd <bob-repo>/ui && npm run test:vitest:hub -- matrix.bob
 */
import { config, dataContext } from '@sdk';
import { Conversation, acceptInvitation, fetchConversations } from '@sdk/entities/conversation';
import {
  BodyStatus,
  ConversationEvents,
  FlowMessage,
  markFlowMessagesReceived,
  type IFlowMessage,
} from '@sdk/entities/flow-message';
import { Invitation } from '@sdk/entities/invitation';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';
import { pollUntil, probeHub, probeLocalBackendLoggedIn, readRendezvous } from './_matrix';

let skipReason: string | null = null;
let bobEmail: string | null = null;

beforeAll(async () => {
  // Hub must be up.
  const hub = await probeHub();
  if (!hub.ok) {
    skipReason = hub.reason ?? 'hub unreachable';
    console.log('[matrix.bob] skip:', skipReason);
    return;
  }

  // Bob's local backend must be cloud-logged-in — its bridge is how he
  // receives alice's messages and how his acks fan back to her.
  const backend = await probeLocalBackendLoggedIn(config.SERVER_URL);
  if (!backend.ok) {
    skipReason = `bob backend (${config.SERVER_URL}) is not cloud-logged-in`;
    console.log('[matrix.bob] skip:', skipReason);
    return;
  }
  bobEmail = backend.email ?? null;
  console.log(`[matrix.bob] ready: backend=${bobEmail}`);
});

const signupInfo = getTestSignupInfo();

beforeEach(async (context: any) => {
  if (skipReason) context.skip();
  await apiTestSetup(signupInfo, context.task.name);
});

// Find the pending invitation for ``convId``. Bob's backend mirrors his
// invitations from the hub via its bridge; the invitation may not have
// arrived the instant we look, so this is polled by the caller.
async function findPendingInvitation(convId: string): Promise<Invitation | null> {
  // fetchConversations() is the production hub catch-up: it pulls bob's
  // conversation + invitation lists from the hub and upserts them into his
  // local DB. Without this, Invitation.query only sees stale local rows.
  await fetchConversations();

  // Now query bob's (freshly-synced) invitation entities.
  const all = await Invitation.query<Invitation>({ query: {} }, true);

  // Prefer an exact match: unaccepted invitation whose target points at our
  // conversation. Fall back to the most-recent unaccepted invitation
  // addressed to bob (covers hubs that don't stamp target_url_path).
  const exact = all.find(
    (inv) => !inv.accepted && (inv.target_url_path || '').includes(convId),
  );
  if (exact) return exact;

  const mine = all
    .filter((inv) => !inv.accepted && inv.recipient_email === bobEmail)
    .sort((a, b) =>
      String(b.created_date ?? '').localeCompare(String(a.created_date ?? '')),
    );
  return mine[0] ?? null;
}

describe('hub: matrix two-process — BOB', () => {
  it('accepts the invite, exchanges messages, downloads + validates the skill', async () => {
    // ── Step 1: learn which conversation to join. ─────────────────────────
    // Alice publishes the conv id after she shares; poll for it.
    const convId = await readRendezvous(25_000);
    console.log(`[matrix.bob] conv id from rendezvous: ${convId.slice(0, 8)}`);

    // ── Step 2: find + accept the invitation. ─────────────────────────────
    // The invitation has to sync down to bob's backend first — poll for it.
    const invitation = await pollUntil(
      () => findPendingInvitation(convId),
      20_000,
      'pending invitation for conv',
    );
    // acceptInvitation hits the real accept-flow: claims the invitation and
    // auto-joins the conversation (the backend POSTs /join for us).
    const accepted = await acceptInvitation({ invitation_id: invitation.id! });
    expect(accepted.invitation_id).toBe(invitation.id);
    // Sanity: the accepted invitation must point at the conv alice published.
    if (accepted.conversation_id) {
      expect(accepted.conversation_id).toBe(convId);
    }
    console.log('[matrix.bob] invitation accepted + joined');

    // ── Step 3: load the conversation, install the message tap. ───────────
    // Post-accept the conv is materialized on bob's backend; load it via SDK.
    const conv = await pollUntil(
      () => Conversation.getById<Conversation>(convId),
      10_000,
      'conversation materialized',
    );

    const inbox: IFlowMessage[] = [];
    const offMessage = conv.on(ConversationEvents.MESSAGE, (m: IFlowMessage) => {
      inbox.push(m);
    });

    try {
      // Handshake: tell alice bob is a live participant now.
      await conv.addMessage('bob-joined');
      console.log(`[matrix.bob] handshake sent; conv.id=${conv.id}`);

      // ── Step 4: receive alice's first message, ack it, reply. ───────────
      // The hub fans the create frame straight to conv.on('message') —
      // poll the inbox until alice's first message lands.
      const aliceHi = await pollUntil(
        () => inbox.find((m) => (m.text || '').trim() === 'hi-from-alice'),
        15_000,
        'hi-from-alice',
      );
      // Explicit read-ack — the "user opened the conversation" action. Bob's
      // bridge already auto-acked 'delivered' on arrival; this bumps it to
      // 'received' and fans the update back to alice.
      await markFlowMessagesReceived([aliceHi.id!]);
      await conv.addMessage('hi-from-bob');
      console.log('[matrix.bob] replied to alice');

      // ── Step 5: receive + download + validate the skill bundle. ─────────
      // The skill message arrives as a create while its body is still
      // uploading on alice's side; wait until the hub flips body_status to
      // READY before downloading.
      const skillMsg = await pollUntil(
        () => inbox.find((m) => (m.text || '').trim() === 'matrix-skill-from-alice'),
        20_000,
        'skill message',
      );
      // Body upload finishes asynchronously on alice's side; when it
      // completes the hub fans out a body_status UPDATE, so the cached FM
      // flips to READY.
      const skillReady = await pollUntil(
        async () => {
          const fm = await FlowMessage.getById<FlowMessage>(skillMsg.id!);
          return fm && fm.body_status === BodyStatus.READY ? fm : null;
        },
        20_000,
        'skill body READY',
      );

      // downloadBody pulls the .flowmsg bundle through bob's backend and
      // unpacks it into his local entities. It throws if body isn't READY.
      await skillReady.downloadBody();

      // Validate: the downloaded FM carries alice's skill attachment.
      expect(skillReady.body_status).toBe(BodyStatus.READY);
      expect(Array.isArray(skillReady.attachment)).toBe(true);
      expect(skillReady.attachment.length).toBeGreaterThan(0);
      console.log('[matrix.bob] skill downloaded + validated');

      // Read-ack the skill message too.
      await markFlowMessagesReceived([skillMsg.id!]);

      // ── Step 6: thank alice — closes the scenario on her side. ──────────
      await conv.addMessage('thanks');
      console.log('[matrix.bob] thanks sent — done');
    } finally {
      offMessage();
    }

    void dataContext;
  });
});
