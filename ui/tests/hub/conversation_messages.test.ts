/**
 * Conversation.on('message') validation — TypeScript mirror of the Python
 * two-client loop in ``tests/hub_tests/test_two_client_loop.py``.
 *
 * One identity (alice) is the LOCAL user that vitest is running against. A
 * second identity (bob) is loaded from the sibling ``flowpad-app`` repo's
 * ``.env.local`` and exchanges a hub bearer token directly. Bob then sends
 * five messages into alice's conversation via the hub. The test asserts
 * alice's ``conv.on('message', cb)`` fires once per send with the correct
 * text. This exercises the full path:
 *
 *   bob → hub /add_message
 *        → hub _fanout_message (skips bob, hits alice)
 *        → alice's local backend hub WS bridge
 *        → local DataManager onDataOp(create, flow_message)
 *        → Conversation message tap (filters by conversation_id)
 *        → conv.emit('message', m)
 */
import { config } from '@sdk';
import { Conversation } from '@sdk/entities/conversation';
import type { IFlowMessage } from '@sdk/entities/flow-message';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';
import {
  HUB_URL,
  getAliceCreds,
  getBobCreds,
  hubAvailable,
  hubLogin,
  localBackendIsCloudLoggedIn,
} from './_hub';

const N_MESSAGES = 5;
let skipReason: string | null = null;
let bobToken: string | null = null;
let bobId: string | null = null;

beforeAll(async () => {
  const hub = await hubAvailable();
  if (!hub.ok) {
    skipReason = hub.reason ?? 'hub unreachable';
    return;
  }
  if (!(await localBackendIsCloudLoggedIn(config.SERVER_URL))) {
    skipReason = 'local backend is not cloud-logged-in (run `flowpad cloud login`)';
    return;
  }
  const alice = await getAliceCreds();
  const bob = await getBobCreds();
  if (!alice) {
    skipReason = 'missing FLOWPAD_CLOUD_USER_{EMAIL,PASSWORD} in flowpad-oss/.env.local';
    return;
  }
  if (!bob) {
    skipReason = 'missing FLOWPAD_CLOUD_USER_{EMAIL,PASSWORD} in flowpad-app/.env.local';
    return;
  }
  // Sanity-check both logins resolve up-front so the test body is purely about
  // the message round-trip, not credential plumbing.
  await hubLogin(alice.email, alice.password);
  const bobLogin = await hubLogin(bob.email, bob.password);
  bobToken = bobLogin.token;
  bobId = bobLogin.user.id;
});

const signupInfo = getTestSignupInfo();

beforeEach(async (context: any) => {
  if (skipReason) context.skip();
  await apiTestSetup(signupInfo, context.task.name);
});

describe('hub: Conversation.on("message")', () => {
  it(`receives ${N_MESSAGES} inbound messages over the WS bridge`, async () => {
    const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

    // Alice (the test client) creates a hub-mirrored conversation. The
    // generic ``share`` override on the Python Conversation pre-populates
    // ``participants`` with alice's user_id so the hub's ``_fanout_message``
    // has a non-empty list to walk. Bob will get added below.
    const conv = new Conversation({ title: `messages-${ts}` });
    await conv.share();
    expect(conv.remote).toBe(true);

    // Add bob to the hub-side conversation as a participant via the hub's
    // ``pickup`` action. ``pickup`` only succeeds if bob is a project member,
    // so we bring bob in via the same path the two-client Python loop uses:
    // alice creates a project + ``start_guest_conversation`` then we re-share
    // alice's conversation participants. The simpler route here is a direct
    // PATCH on the hub-side conversation — but the hub doesn't expose one.
    // Instead, drive bob in by giving him a direct ``add_message`` send: the
    // hub will reject if he's not a participant, so we attach him first by
    // creating a fresh guest conversation alongside alice's. The test only
    // cares about ``conv.on('message')`` semantics, so we use the
    // guest-conversation path end-to-end.
    //
    // Plan B (current implementation): use the guest_conversation that ships
    // with bob-as-participant on creation. We replace ``conv`` with the one
    // returned from start_guest_conversation.
    const aliceCreds = await getAliceCreds();
    if (!aliceCreds) throw new Error('alice creds vanished after beforeAll');
    const { token: aliceToken } = await hubLogin(aliceCreds.email, aliceCreds.password);

    // Alice creates a project + guest conversation with bob attached.
    const projResp = await fetch(`${HUB_URL}/api/v1/graph/project`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ name: `vitest-msg-${Date.now()}` }),
    });
    const projBody = (await projResp.json()) as { data: { id: string } };
    const projectId = projBody.data.id;

    const convResp = await fetch(
      `${HUB_URL}/api/v1/graph/project/${projectId}/start_guest_conversation`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
        body: JSON.stringify({
          text: 'init',
          receiver_address: bobId!,
          receiver_address_type: 'id',
        }),
      },
    );
    const convBody = (await convResp.json()) as { data: { id: string } };
    const hubConv = new Conversation({ id: convBody.data.id, title: `messages-${ts}` });

    // Subscribe BEFORE bob starts sending.
    const received: IFlowMessage[] = [];
    const done = new Promise<void>((resolve) => {
      const off = hubConv.on('message', (m: IFlowMessage) => {
        received.push(m);
        if (received.length >= N_MESSAGES) {
          off();
          resolve();
        }
      });
    });

    // Bob fires N messages directly at the hub.
    for (let i = 1; i <= N_MESSAGES; i++) {
      const r = await fetch(
        `${HUB_URL}/api/v1/graph/conversation/${hubConv.id}/add_message`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bobToken}` },
          body: JSON.stringify({ text: `m${i}` }),
        },
      );
      expect(r.status, `bob.add_message[${i}] failed: ${await r.text()}`).toBe(200);
    }

    await done;
    expect(received.length).toBe(N_MESSAGES);
    const texts = received.map((m) => m.text);
    expect(texts.sort()).toEqual(
      Array.from({ length: N_MESSAGES }, (_, i) => `m${i + 1}`).sort(),
    );
    for (const m of received) {
      expect(m.sender_id).toBe(bobId);
    }
  });
});
