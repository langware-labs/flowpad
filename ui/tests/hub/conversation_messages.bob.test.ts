/**
 * BOB side of the two-vitest ping-pong. Companion: ``conversation_messages.test.ts``
 * (alice). Run concurrently, bob pointed at a bob-logged-in backend:
 *
 *   VITE_API_URL=http://localhost:<bob-be> npx vitest run --project hub \
 *     tests/hub/conversation_messages.bob.test.ts
 *
 * Protocol (documented in the alice file): bob polls the rendezvous file for
 * the conv id, accepts the invitation (exact conv match), sends the "0"
 * handshake, then mirrors alice's loop — rx n → tx n+1 — until STOP_AT.
 * Pure SDK on this side, same as alice: catch-up via fetchConversations,
 * receive tap via conv.on('message'), sends via conv.addMessage.
 */
import { config, dataManager } from '@sdk';
import { Conversation, acceptInvitation, fetchConversations } from '@sdk/entities/conversation';
import type { FlowMessage } from '@sdk/entities/flow-message';
import { Invitation } from '@sdk/entities/invitation';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';
import { pollUntil, probeHub, probeLocalBackendLoggedIn } from './_matrix';

const STOP_AT = 20;
const RENDEZVOUS = '/tmp/flowpad_pingpong_conv.txt';

let skipReason: string | null = null;

beforeAll(async () => {
  const hub = await probeHub();
  if (!hub.ok) return void (skipReason = hub.reason ?? 'hub unreachable');
  const backend = await probeLocalBackendLoggedIn(config.SERVER_URL);
  if (!backend.ok) return void (skipReason = `bob backend (${config.SERVER_URL}) is not cloud-logged-in`);
}, 120_000);

const signupInfo = getTestSignupInfo();

beforeEach(async (context: any) => {
  if (skipReason) context.skip();
  // Bootstrap this SDK realm against bob's backend (loads schema types +
  // connects the WS) — same setup matrix.bob uses; without it Invitation
  // queries limp ("Schema not found") and conv.on('message') has no socket.
  await apiTestSetup(signupInfo, context.task.name);
});

// One full hub catch-up after the rendezvous (alice creates the invitation
// BEFORE publishing the conv id, so a single fetch is guaranteed to include
// it); the per-poll query is then local-only and cheap — re-running the full
// catch-up per poll is what blew alice's protocol budget on a hub with a
// large invitation backlog.
async function findPendingInvitation(convId: string): Promise<Invitation | null> {
  // Exact-filter on the persisted invitation→conversation linkage — an
  // unfiltered query refetches the whole invitation backlog (~1s per poll on
  // a long-lived hub), which alone blew alice's protocol budget.
  const matches = await Invitation.query<Invitation>(
    { query: { target_url_path: `/conversation/${convId}` } },
    true,
  );
  return matches.find((inv) => !inv.accepted) ?? null;
}

describe(`hub: bob ping-pong companion to ${STOP_AT}`, () => {
  it('accepts the invite, handshakes 0, and mirrors rx n → tx n+1', async () => {
    const fs = await import('node:fs/promises');
    // Pre-warm the hub catch-up before alice's window opens: the FIRST
    // fetchConversations materializes the full backlog of hub invitations
    // (expensive on a long-lived shared hub); subsequent polls are cheap.
    await fetchConversations().catch(() => {});
    // Poll the ping-pong rendezvous file alice writes after sharing. The
    // launcher clears it before starting both halves, so any content is
    // THIS run's conv id.
    const convId = await pollUntil(
      async () => {
        const id = await fs.readFile(RENDEZVOUS, 'utf-8').then((s) => s.trim()).catch(() => '');
        return id || null;
      },
      25_000,
      'pingpong rendezvous',
    );

    const t0 = Date.now();
    const mark = (label: string) => console.log(`[pp-bob] +${Date.now() - t0}ms ${label}`);
    mark('rendezvous read');
    // Local-first: the hub bridge pushes the invitation to bob's backend in
    // real time, so a cheap local query usually sees it within a second. One
    // full catch-up is the fallback (bridge hiccup) — an unconditional full
    // fetch cost ~3s on a hub with a large backlog and blew alice's budget.
    let invitation = await pollUntil(() => findPendingInvitation(convId), 3_000, 'pending invitation (local)')
      .catch(() => null);
    if (!invitation) {
      await fetchConversations();
      mark('fallback fetchConversations done');
      invitation = await pollUntil(() => findPendingInvitation(convId), 17_000, 'pending invitation for conv');
    }
    mark('invitation found');
    await acceptInvitation({ invitation_id: invitation!.id! });
    mark('accepted');

    const conv = await pollUntil(
      async () => (await Conversation.getById<Conversation>(convId)) ?? null,
      10_000,
      'conversation materialized locally',
    );

    const seen = new Set<number>();
    let maxRx = 0;
    const done = new Promise<void>((resolve) => {
      const off = conv!.on('message', (m: FlowMessage) => {
        const text = (m.text || '').trim();
        if (!/^\d+$/.test(text)) return;
        const n = parseInt(text, 10);
        if (seen.has(n)) return; // hub frame + bridge CREATE arrive twice
        seen.add(n);
        maxRx = Math.max(maxRx, n);
        if (n >= STOP_AT) {
          off();
          resolve();
          return;
        }
        // Reply ONLY to alice's numbers (odd). The tap also hears bob's own
        // sends echoed back (including the "0" handshake) — replying to those
        // forks parallel counter chains and multiplies the message volume.
        if (n % 2 === 0) return;
        void conv!.addMessage(String(n + 1)).then(() => {
          if (n + 1 >= STOP_AT) {
            off();
            resolve();
          }
        });
      });
    });

    mark('conversation loaded');
    // Handshake: tells alice we joined and the realtime tap is live.
    await conv!.addMessage('0');
    mark('handshake 0 sent');
    await done;
    mark(`loop done (maxRx=${maxRx})`);

    expect(maxRx).toBeGreaterThanOrEqual(STOP_AT - 1);
    void dataManager;
  }, 60_000);
});
