/**
 * Two-instance hub conversation — alice ↔ bob through the local hub.
 * Source: two_instance_hub_conversation.md (binding criterion = step 6).
 *
 * TWO-INSTANCE PRECONDITION: this exercises a real conversation between two
 * SEPARATE cloud-logged-in hub users —
 *   - alice = this instance (qa-2, hub user qa-2@local.test)
 *   - bob   = a second instance (qa-1, hub user qa-1@local.test), driven by the
 *             paired qa-tester-1
 * both cloud-logged-in against the local hub (:8093) via instance_ctl. When only
 * one instance is available the test skips (guard below) — set QA_BOB_HUB_ID to
 * bob's hub user id to enable it.
 *
 * SCOPE: this encodes the .md's BINDING CRITERION (step 6) — the alice↔bob hub
 * conversation round-trip, asserting both messages are visible to both users.
 * The .md's dev-vs-prod KEYRING-PARTITION assertions (steps 4/5/8/9 — the
 * flowpad-oss `flowpad_api_key:dev` vs flowpad-app `flowpad_api_key` slot scheme
 * across two CHECKOUTS) are genuinely out of an instance_ctl two-instance rig
 * and are recorded as confirmed-skip in the result JSON, not encoded here.
 */
import { test, expect, request as pwRequest, type APIRequestContext } from '@playwright/test';

// Hub origin — REQUIRED. This test intentionally targets a specific two-instance
// hub rig, so there is no localhost fallback: set QA_HUB_URL explicitly.
const HUB = process.env.QA_HUB_URL || '';
const ALICE_EMAIL = process.env.QA_ALICE_EMAIL || 'qa-2@local.test';
const ALICE_PW = process.env.QA_ALICE_PW || 'qa-2-pw-1234';
const BOB_EMAIL = process.env.QA_BOB_EMAIL || 'qa-1@local.test';
const BOB_PW = process.env.QA_BOB_PW || 'qa-1-pw-1234';
// Bob's hub user id — provided by the paired tester (qa-1 side). The test
// skips when absent (single-instance run).
const BOB_HUB_ID = process.env.QA_BOB_HUB_ID || '';

async function hubLogin(rq: APIRequestContext, email: string, pw: string): Promise<{ token: string; id: string }> {
  const res = await rq.post(`${HUB}/api/v1/login`, { data: { email, password: pw } });
  expect(res.status(), `hub login ${email}`).toBe(200);
  const d = (await res.json()).data;
  expect(d?.token, `token for ${email}`).toBeTruthy();
  return { token: d.token, id: d.user.id };
}

function auth(token: string) {
  return { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
}

test('binding criterion: real alice↔bob conversation through the local hub', async () => {
  test.skip(
    !BOB_HUB_ID,
    'two-instance: requires a second cloud-logged-in instance (bob/qa-1). Set QA_BOB_HUB_ID (bob hub user id) to run. The paired qa-tester-1 drives bob on qa-1.',
  );
  if (!HUB) {
    throw new Error(
      'QA_HUB_URL is not set — this two-instance test requires an explicit hub origin (the instance_ctl local hub); there is no localhost fallback.',
    );
  }
  test.setTimeout(60_000);
  const rq = await pwRequest.newContext();

  // Hub liveness.
  expect((await rq.get(`${HUB}/api/v1/login/test`)).status()).toBe(200);

  // Two distinct hub users, each with their own JWT.
  const alice = await hubLogin(rq, ALICE_EMAIL, ALICE_PW);
  const bob = await hubLogin(rq, BOB_EMAIL, BOB_PW);
  expect(bob.id, 'bob id matches the provided QA_BOB_HUB_ID').toBe(BOB_HUB_ID);
  expect(alice.id).not.toBe(bob.id);

  // alice creates a hub project.
  const proj = await rq.post(`${HUB}/api/v1/graph/project`, { ...auth(alice.token), data: { name: `alice-bob-chat-${Date.now()}` } });
  expect(proj.status()).toBe(200);
  const pid: string = (await proj.json()).data.id;

  // alice starts a guest conversation addressed to bob by id, first message "hi".
  const startRes = await rq.post(`${HUB}/api/v1/graph/project/${pid}/start_guest_conversation`, {
    ...auth(alice.token),
    data: { text: 'hi', receiver_address: bob.id, receiver_address_type: 'id' },
  });
  expect(startRes.status()).toBe(200);
  const start = await startRes.json();
  expect(start.status).toBe('SUCCESS');
  const conv: string = start.data.id;
  expect(conv).toMatch(/^[0-9a-f-]{36}$/);

  // bob discovers the conversation in his list and can read the first message.
  await expect(async () => {
    const list = (await (await rq.get(`${HUB}/api/v1/graph/conversation`, auth(bob.token))).json()).data ?? [];
    expect(list.some((c: { id: string }) => c.id === conv), 'bob sees the conversation').toBe(true);
  }).toPass({ timeout: 15_000 });

  await expect(async () => {
    const msgs = (await (await rq.get(`${HUB}/api/v1/graph/conversation/${conv}/flow_message`, auth(bob.token))).json()).data ?? [];
    const hi = msgs.find((m: { text: string }) => m.text === 'hi');
    expect(hi, 'bob reads alice\'s "hi"').toBeTruthy();
    expect(hi.sender_id).toBe(alice.id);
  }).toPass({ timeout: 15_000 });

  // bob replies "whats app".
  const reply = await rq.post(`${HUB}/api/v1/graph/conversation/${conv}/add_message`, { ...auth(bob.token), data: { text: 'whats app' } });
  expect(reply.status()).toBe(200);
  expect((await reply.json()).data.text).toBe('whats app');

  // alice reads back the full transcript — both messages, both senders, ordered.
  await expect(async () => {
    const msgs = ((await (await rq.get(`${HUB}/api/v1/graph/conversation/${conv}/flow_message`, auth(alice.token))).json()).data ?? [])
      .slice()
      .sort((a: { created_date?: string }, b: { created_date?: string }) => (a.created_date ?? '').localeCompare(b.created_date ?? ''));
    const texts = msgs.map((m: { text: string }) => m.text);
    expect(texts).toContain('hi');
    expect(texts).toContain('whats app');
    const hi = msgs.find((m: { text: string }) => m.text === 'hi');
    const wa = msgs.find((m: { text: string }) => m.text === 'whats app');
    expect(hi.sender_id).toBe(alice.id);
    expect(wa.sender_id).toBe(bob.id);
  }).toPass({ timeout: 15_000 });

  await rq.dispose();
});
