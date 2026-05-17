/**
 * ALICE side of the two-process matrix test. Companion: ``matrix.bob.test.ts``.
 *
 * Both halves run as SEPARATE vitest processes against SEPARATE local backends
 * (alice → :9008, bob → :9007). Neither simulates the other — each drives the
 * real production SDK against its own real backend; the backends bridge to the
 * shared hub. This is option #2: zero raw-hub simulation, both sides real.
 *
 * Scenario (alice's half):
 *   1. Create + share a conversation; publish its id to the rendezvous file.
 *   2. Wait for bob's "bob-joined" handshake (proves he accepted + joined).
 *   3. Send "hi-from-alice".
 *   4. Wait for bob's "hi-from-bob" reply.
 *   5. Send a skill-bearing message (addMessage + uploadBody).
 *   6. Wait for bob's "thanks".
 *   7. Assert both of alice's sent messages reached delivery_status='received'
 *      — proof that bob's bridge auto-delivered AND bob marked them read.
 *
 * Run: from alice's checkout —
 *   cd <alice-repo>/ui && npm run test:vitest:hub -- matrix.alice
 */
import { config, dataContext } from '@sdk';
import { Conversation } from '@sdk/entities/conversation';
import { ConversationEvents, FlowMessage, type IFlowMessage } from '@sdk/entities/flow-message';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';
import { getBobCreds } from './_hub';
import {
  clearRendezvous,
  pollUntil,
  probeHub,
  probeLocalBackendLoggedIn,
  writeRendezvous,
} from './_matrix';

let skipReason: string | null = null;
let bobEmail: string | null = null;

beforeAll(async () => {
  // Hub must be up — it's the shared meeting point for both backends.
  const hub = await probeHub();
  if (!hub.ok) {
    skipReason = hub.reason ?? 'hub unreachable';
    console.log('[matrix.alice] skip:', skipReason);
    return;
  }

  // Alice's local backend must be cloud-logged-in (its hub bridge carries
  // every send/receive). config.SERVER_URL points at alice's backend.
  const backend = await probeLocalBackendLoggedIn(config.SERVER_URL);
  if (!backend.ok) {
    skipReason = `alice backend (${config.SERVER_URL}) is not cloud-logged-in`;
    console.log('[matrix.alice] skip:', skipReason);
    return;
  }

  // We only need bob's EMAIL on alice's side — to address the share/invite.
  // (Bob authenticates himself through his own backend in matrix.bob.)
  const bob = await getBobCreds();
  if (!bob) {
    skipReason = 'missing bob creds in REPO_APP/.env.local';
    console.log('[matrix.alice] skip:', skipReason);
    return;
  }
  bobEmail = bob.email;
  console.log(`[matrix.alice] ready: backend=${backend.email} inviting=${bobEmail}`);
});

const signupInfo = getTestSignupInfo();

beforeEach(async (context: any) => {
  if (skipReason) context.skip();
  // Sign this process into alice's LOCAL backend so SDK calls succeed.
  await apiTestSetup(signupInfo, context.task.name);
});

// A fake-but-stable skill typeid for the attachment — the backend packs
// whatever's at that typeid into the bundle; we just need a TYPE_ID
// attachment present so the body lifecycle (UPLOADING → READY) runs.
const SKILL_ID = 'skill-deadbeef-0000-0000-0000-000000000001';

describe('hub: matrix two-process — ALICE', () => {
  it('creates, shares, exchanges messages + skill with the real bob backend', async () => {
    // Clear any stale rendezvous file BEFORE creating the conv, so bob can't
    // read a previous run's conv id during the gap.
    await clearRendezvous();

    // ── Step 1: create + share the conversation (real SDK). ───────────────
    const conv = new Conversation({ title: `matrix-2p-${Date.now()}` });
    await conv.save();
    await conv.share([bobEmail!]);
    expect(conv.remote).toBe(true);

    // Collect every inbound message on this conv via the production SDK tap.
    const inbox: IFlowMessage[] = [];
    const offMessage = conv.on(ConversationEvents.MESSAGE, (m: IFlowMessage) => {
      inbox.push(m);
    });

    try {
      // Publish the conv id — bob's process is polling the rendezvous file.
      await writeRendezvous(conv.id);
      console.log(`[matrix.alice] conv ${conv.id.slice(0, 8)} shared + published`);

      // ── Step 2: wait for bob's handshake. ───────────────────────────────
      // Bob sends "bob-joined" right after he accepts + joins. Receiving it
      // proves bob is a live participant before alice sends anything real.
      await pollUntil(
        () => inbox.find((m) => (m.text || '').trim() === 'bob-joined'),
        20_000,
        'bob-joined handshake',
      );
      console.log('[matrix.alice] bob joined');

      // ── Step 3: alice sends her first message. ──────────────────────────
      const fmHi = await conv.addMessage('hi-from-alice');
      expect(fmHi.id).toBeTruthy();

      // ── Step 4: wait for bob's text reply. ──────────────────────────────
      await pollUntil(
        () => inbox.find((m) => (m.text || '').trim() === 'hi-from-bob'),
        15_000,
        'hi-from-bob reply',
      );
      console.log('[matrix.alice] got bob reply');

      // ── Step 5: alice sends a skill-bearing message. ────────────────────
      // addMessage with a TYPE_ID attachment → hub stamps body_status
      // 'uploading'; uploadBody() then packs + uploads the .flowmsg bundle.
      const skillData = (await conv.addMessage('matrix-skill-from-alice', {
        attachment: [{ attachment_type: 'type_id', data: SKILL_ID }],
      })) as IFlowMessage;
      expect(skillData.body_status).toBe('uploading');
      // addMessage returns a plain IFlowMessage; the SDK already registered
      // the live FlowMessage entity for this id (via the WS create fanout).
      // Fetch that instance — constructing a second one for the same id is
      // what the DataManager rejects ("already registered").
      const fmSkill = await FlowMessage.getById<FlowMessage>(skillData.id!);
      expect(fmSkill).toBeTruthy();
      await fmSkill!.uploadBody();
      console.log('[matrix.alice] skill uploaded');

      // ── Step 6: wait for bob's "thanks" (he sends it after download). ───
      await pollUntil(
        () => inbox.find((m) => (m.text || '').trim() === 'thanks'),
        20_000,
        'thanks from bob',
      );
      console.log('[matrix.alice] got thanks');

      // ── Step 7: ack assertions. ─────────────────────────────────────────
      // waitForAck resolves once bob's receipt fans back: bob's bridge
      // auto-acks 'delivered' on arrival, then bob explicitly marks each
      // message read ('received') — all real behavior, no simulation.
      const hiEntity = await FlowMessage.getById<FlowMessage>(fmHi.id!);
      expect(hiEntity).toBeTruthy();
      await hiEntity!.waitForAck(15_000);
      expect(hiEntity!.received_at).toBeTruthy();

      await fmSkill!.waitForAck(15_000);
      expect(fmSkill!.received_at).toBeTruthy();
      console.log('[matrix.alice] both sends reached received — done');
    } finally {
      offMessage();
    }

    void dataContext;
  });
});
