/**
 * Secured transfer to a member with NO key yet ("installs later"), through the REAL hub, two instances.
 *
 * Alice shares a credential's values with Bob while Bob's Flowpad has no published key (receiving off = not
 * installed yet). Alice gets no warning: a hub-only promise (`sealed_pending`) waits. Bob opens the message →
 * "Get the secret" publishes his key and asks (`sealed_request` + a quiet thread note); Alice's Flowpad answers BY
 * ITSELF — live, or on its catch-up after being offline — sealing for Bob's new device; Bob fills.
 *
 * Launch recipe: the same as credential_secure_share_two_client.test.ts (sst-1 = Alice, sst-2 = Bob).
 */
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getAliceCreds, getBobCreds, hubAvailable, hubJson, hubLogin } from './_hub';
import { pollUntil } from './_matrix';
import { testEntityName, trackForCleanup } from '../_cleanup';
import {
  HUB_INST_1 as INST_1,
  HUB_INST_2 as INST_2,
  getInstance,
  instanceAvailable,
  jsonApi,
  postApi,
  queryConversationMessages,
  syncAssignedConversation,
  type ResolvedInstance,
} from './_instances';

const RUN = Math.random().toString(36).slice(2, 8).toUpperCase();
const SECRET = `sk-later-${RUN}-SUPERSECRET`;
const CRED = `acme-later-${RUN.toLowerCase()}`;
const PASS = `L${RUN}_PASSWORD`;
const CREDS = '/graph/compute_node/@local/credentials';
const REPO = path.resolve(__dirname, '../../..');
const PREF = 'preferences.sharing.secure_receiving';

let skipReason: string | null = null;
let alice: ResolvedInstance;
let bob: ResolvedInstance;
let aliceHub: { token: string; user: { id: string } };
let bobHub: { token: string; user: { id: string } };
let credTypeid = '';
let bobProject: any;

const instanceDir = (name: string) => path.join(os.homedir(), '.flow', 'instances', name);
const readEnv = (project: any): Record<string, string> => {
  const file = path.join(project.fs_storage_mount_path, '.env.local');
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, 'utf-8').split('\n').filter((l) => l.includes('=')).map((l) => {
    const i = l.indexOf('=');
    return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')];
  }));
};
async function ok(p: Promise<any>, what: string) {
  const body = await p;
  if (!/success/i.test(String(body?.status))) throw new Error(`${what}: ${JSON.stringify(body)}`);
  return body.data;
}
/** One request on a FRESH connection (`agent: false`): a pooled keep-alive socket the server closed while an
 *  instance was being relaunched would otherwise surface as ECONNRESET on reuse. */
function call(url: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(url, { method, agent: false, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => { try { resolve({ http: res.statusCode, ...JSON.parse(raw || '{}') }); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const sealed = (inst: ResolvedInstance, verb: string, body: any, headers: Record<string, string> = {}) =>
  call(`${inst.apiUrl}/api/v1${CREDS}/sealed/${verb}`, 'POST', body, headers);
const stateOf = async (inst: ResolvedInstance, conv: string) =>
  (await ok(call(`${inst.apiUrl}/api/v1${CREDS}/sealed/state?conversation_id=${conv}`), `state ${inst.name}`)) as { incoming: any[]; sent: any[] };
const hubMessages = async (token: string, conv: string) => ((await hubJson(token, `/graph/conversation/${conv}/flow_message`)) as any[]) ?? [];
const ofKind = (rows: any[], kind: string) => rows.filter((m) => m.kind === kind);

/** Bob "has not installed Flowpad yet": receiving off → his key withdrawn from the hub. */
async function bobWithoutKey() {
  const prefs = path.join(instanceDir(INST_2), 'preferences.json');
  const cur = existsSync(prefs) ? JSON.parse(readFileSync(prefs, 'utf-8')) : {};
  writeFileSync(prefs, JSON.stringify({ ...cur, [PREF]: false }));
  await ok(postApi(bob.apiUrl, `${CREDS}/sealed/publish`, {}), 'bob withdraws');
  const mine = await hubJson(bobHub.token, `/graph/user/${bobHub.user.id}/device_key`);
  expect(mine).toEqual([]);
}

/** A fresh conversation where Alice shares the credential (its own message = the thread root), then seals. */
async function shareToBob() {
  const conv = trackForCleanup(new alice.sdk.Conversation({ title: testEntityName('later') }));
  await conv.save();
  await conv.share([bob.email]);
  await syncAssignedConversation(bob, conv.id);
  const root = (await ok(postApi(alice.apiUrl, `/graph/conversation/${conv.id}/add_message`, {
    message: 'Here are the Acme credentials', asset_references: [credTypeid],
  }), 'share message')).flow_message_id as string;
  const out = await ok(sealed(alice, 'seal', { typeid: credTypeid, conversation_id: conv.id }), 'seal');
  return { convId: conv.id as string, root, out };
}

beforeAll(async () => {
  const hub = await hubAvailable();
  if (!hub.ok) return void (skipReason = hub.reason ?? 'hub unreachable');
  if (!instanceAvailable(INST_1) || !instanceAvailable(INST_2)) return void (skipReason = `launch ${INST_1} + ${INST_2}`);
  const [a, b] = [await getAliceCreds(), await getBobCreds()];
  if (!a || !b) return void (skipReason = 'set the ALICE_ and BOB_ credentials');
  alice = await getInstance(INST_1);
  bob = await getInstance(INST_2);
  aliceHub = await hubLogin(a.email, a.password);
  bobHub = await hubLogin(b.email, b.password);
  await ok(postApi(alice.apiUrl, `${CREDS}/sealed/publish`, {}), 'alice publishes');
  const manifest = { name: CRED, title: 'Acme (later)', setup: 'manual', vars: { [PASS]: {} } };
  const projects = async (inst: ResolvedInstance) => ((await jsonApi(inst.apiUrl, '/graph/project')).data ?? [])
    .find((p: any) => p.fs_storage_mount_path?.includes(`/instances/${inst.name}/`));
  const aliceProject = await projects(alice);
  bobProject = await projects(bob);
  credTypeid = (await ok(postApi(alice.apiUrl, `${CREDS}/save`, { scope: 'project', project_id: aliceProject.id, manifest,
    values: { [PASS]: SECRET } }), 'alice declares')).typeid;
  await ok(postApi(bob.apiUrl, `${CREDS}/save`, { scope: 'project', project_id: bobProject.id, manifest }), 'bob declares');
}, 180_000);

beforeEach((context: any) => {
  if (skipReason) context.skip();
});

afterAll(async () => {
  if (!bob) return;
  const prefs = path.join(instanceDir(INST_2), 'preferences.json');
  const cur = existsSync(prefs) ? JSON.parse(readFileSync(prefs, 'utf-8')) : {};
  writeFileSync(prefs, JSON.stringify({ ...cur, [PREF]: true }));  // leave Bob able to receive
  await postApi(bob.apiUrl, `${CREDS}/sealed/publish`, {}).catch(() => undefined);
});

describe('secured transfer — the recipient installs later', () => {
  it('L1+L2: no warning to Alice; Bob gets the secret; Alice answers by herself; Bob fills; quiet thread notes', async () => {
    await bobWithoutKey();
    const { convId, root, out } = await shareToBob();
    expect(out.sealed_for).toEqual([]);
    expect(out.later).toEqual([bobHub.user.id]);
    expect(out.cannot_receive).toEqual([]);

    // L1 — the promise on the hub names Bob, never the credential or its variables or values
    const promise = ofKind(await hubMessages(bobHub.token, convId), 'sealed_pending');
    expect(promise.length).toBe(1);
    const promiseText = JSON.stringify(promise);
    for (const leak of [SECRET, PASS, CRED]) expect(promiseText).not.toContain(leak);
    expect((await stateOf(alice, convId)).sent[0].recipients).toEqual({ [bobHub.user.id]: 'pending' });

    // L2 — Bob opens: "Get the secret"
    const card = (await stateOf(bob, convId)).incoming.find((c) => c.state === 'get');
    expect(card).toBeTruthy();
    await ok(sealed(bob, 'get', { conversation_id: convId, transfer_id: card.transfer_id }), 'get');
    expect((await hubJson(bobHub.token, `/graph/user/${bobHub.user.id}/device_key`)).length).toBe(1); // key published

    // Alice's Flowpad answers live (the request fans out to her bridge) — no click on her side
    const ready = await pollUntil(async () => (await stateOf(bob, convId)).incoming.find((c) => c.state === 'pending') ?? null,
      30_000, 'Alice answered by herself');
    await ok(sealed(bob, 'fill', { conversation_id: convId, message_id: ready.message_id, project_id: bobProject.id }), 'fill');
    expect(readEnv(bobProject)[PASS]).toBe(SECRET);

    // the quiet thread: two notes, replies to the share message, on the hub and as local rows on BOTH sides
    const onHub = await hubMessages(aliceHub.token, convId);
    const notes = ofKind(onHub, 'sealed_note');
    expect(notes.length).toBe(2);
    expect(notes.some((n) => /shared public key for secured transfer$/.test(n.text))).toBe(true);
    expect(notes.some((n) => /^Secured transfer key sent to /.test(n.text))).toBe(true);
    for (const n of notes) expect(n.reply_to_id).toBe(root);
    for (const inst of [alice, bob]) {
      const local = await pollUntil(async () => {
        const rows = (await queryConversationMessages(inst, convId)).filter((m: any) => m.kind === 'sealed_note');
        return rows.length === 2 ? rows : null;
      }, 20_000, `notes on ${inst.name}`);
      expect(local.length).toBe(2);
      // hub-only kinds never became local rows
      expect((await queryConversationMessages(inst, convId)).some((m: any) =>
        ['sealed_value', 'sealed_ack', 'sealed_pending', 'sealed_request'].includes(m.kind))).toBe(false);
    }
    // the promise was kept and withdrawn
    await pollUntil(async () => (ofKind(await hubMessages(aliceHub.token, convId), 'sealed_pending').length ? null : true),
      20_000, 'promise withdrawn');

    // L8 — no plaintext on the hub or in either install's logs
    const all = JSON.stringify(await hubMessages(aliceHub.token, convId));
    expect(all).not.toContain(SECRET);
    for (const inst of [INST_1, INST_2]) {
      const log = path.join(instanceDir(inst), 'launcher-backend.log');
      if (existsSync(log)) expect(readFileSync(log, 'utf-8')).not.toContain(SECRET);
    }
  }, 180_000);

  it('L4+L5+L7: a forged request, a replayed one, and a scripted Get are refused', async () => {
    await bobWithoutKey();
    const { convId, out } = await shareToBob();
    const tid = ofKind(await hubMessages(bobHub.token, convId), 'sealed_pending')[0].metadata.transfer_id;

    // L7 — Get from a script (gate header) is refused
    const scripted = await sealed(bob, 'get', { conversation_id: convId, transfer_id: tid }, { 'x-cookie-gate': 'script' });
    expect(scripted.http).toBe(403);

    // L4 — a request for a transfer id nobody promised: Alice ignores it
    await hubJson(bobHub.token, `/graph/conversation/${convId}/add_message`, { text: '', kind: 'sealed_request', metadata: { transfer_id: 'forged' } });
    await new Promise((r) => setTimeout(r, 3000));
    expect(ofKind(await hubMessages(aliceHub.token, convId), 'sealed_value')).toEqual([]);

    // the real Get, answered once
    await ok(sealed(bob, 'get', { conversation_id: convId, transfer_id: tid }), 'get');
    await pollUntil(async () => (ofKind(await hubMessages(aliceHub.token, convId), 'sealed_value').length === 1 ? true : null),
      30_000, 'answered once');
    // L5 — a replayed request after the answer seals nothing more
    await hubJson(bobHub.token, `/graph/conversation/${convId}/add_message`, { text: '', kind: 'sealed_request', metadata: { transfer_id: tid } });
    await new Promise((r) => setTimeout(r, 4000));
    expect(ofKind(await hubMessages(aliceHub.token, convId), 'sealed_value').length).toBe(1);
    expect(out.later).toEqual([bobHub.user.id]);
  }, 120_000);

  it('L6: an expired promise shows expired and cannot be redeemed', async () => {
    await bobWithoutKey();
    const conv = trackForCleanup(new alice.sdk.Conversation({ title: testEntityName('later-expired') }));
    await conv.save();
    await conv.share([bob.email]);
    await syncAssignedConversation(bob, conv.id);
    // A promise whose time is up (as the hub would carry it after 7 days)
    await hubJson(aliceHub.token, `/graph/conversation/${conv.id}/add_message`, { text: '', kind: 'sealed_pending',
      metadata: { transfer_id: `expired-${RUN}`, recipients: [bobHub.user.id], expires_at: '2000-01-01T00:00:00+00:00', root: null } });
    const card = (await stateOf(bob, conv.id)).incoming.find((c) => c.transfer_id === `expired-${RUN}`);
    expect(card?.state).toBe('expired');
    const refused = await sealed(bob, 'get', { conversation_id: conv.id, transfer_id: `expired-${RUN}` });
    expect(refused.data?.error_code).toBe('expired');
  });

  it('L3: Alice is offline when Bob asks; her catch-up answers when she is back', async () => {
    await bobWithoutKey();
    const { convId } = await shareToBob();
    execFileSync(path.join(REPO, 'scripts/instance_ctl.sh'), ['kill', INST_1, '--keep-env'], { stdio: 'ignore' });
    try {
      const card = (await stateOf(bob, convId)).incoming.find((c) => c.state === 'get');
      await ok(sealed(bob, 'get', { conversation_id: convId, transfer_id: card.transfer_id }), 'get while Alice is away');
      expect((await stateOf(bob, convId)).incoming.find((c) => c.transfer_id === card.transfer_id)?.state).toBe('requested');
      await new Promise((r) => setTimeout(r, 3000));
      expect(ofKind(await hubMessages(bobHub.token, convId), 'sealed_value')).toEqual([]); // nobody answered
    } finally {
      execFileSync(path.join(REPO, 'scripts/instance_ctl.sh'), ['launch', INST_1], { stdio: 'ignore' });
    }
    // back online: the post-sign-in catch-up answers the request by itself
    const ready = await pollUntil(async () => (await stateOf(bob, convId)).incoming.find((c) => c.state === 'pending') ?? null,
      90_000, 'catch-up answered');
    await ok(sealed(bob, 'fill', { conversation_id: convId, message_id: ready.message_id, project_id: bobProject.id }), 'fill');
    expect(readEnv(bobProject)[PASS]).toBe(SECRET);
  }, 300_000);
});
