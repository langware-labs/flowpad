/**
 * Secured transfer, end to end through the REAL hub: Alice (instance 1) shares a credential's VALUES with Bob
 * (instance 2) by secured transfer; Bob fills them in with one call; nothing readable crosses the hub.
 *
 * Each instance publishes its device key to the hub (`<user>/device_key`); Alice reads Bob's key only through
 * the conversation's members action (`list_members/device_keys`), seals on her machine, posts the envelope as an
 * opaque `sealed_value` message; Bob's machine verifies, decrypts and writes through the credential writer, then
 * acks; Alice removes the envelope once answered.
 *
 *   scripts/instance_ctl.sh launch sst-1 && scripts/instance_ctl.sh launch sst-2
 *   cd ui && env -u LOCAL_SERVER_PORT FLOWPAD_HUB_URL=http://localhost:8093 SHARE_INST_1=sst-1 SHARE_INST_2=sst-2 \
 *     ALICE_EMAIL=sst-1@local.test ALICE_PW=sst-1-pw-1234 BOB_EMAIL=sst-2@local.test BOB_PW=sst-2-pw-1234 \
 *     FLOW_INSTANCE=sst-1 npx vitest run --project hub credential_secure_share
 *
 * The hub must run the device-key code (flowpad/hub/builtin/device_key.py); both instances must be relaunched
 * after any flow_sdk change (backends do not hot-reload).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
  syncAssignedConversation,
  type ResolvedInstance,
} from './_instances';

const SECRET = `sk-sealed-${Math.random().toString(36).slice(2)}-SUPERSECRET`;
const RUN = Math.random().toString(36).slice(2, 8).toUpperCase();
const CRED = `acme-gmail-e2e-${RUN.toLowerCase()}`;
const ADDR = `E2E${RUN}_ADDRESS`;
const PASS = `E2E${RUN}_PASSWORD`;
const CREDS = '/graph/compute_node/@local/credentials';

let skipReason: string | null = null;
let alice: ResolvedInstance;
let bob: ResolvedInstance;
let aliceHub: { token: string; user: { id: string } };
let bobHub: { token: string; user: { id: string } };
let aliceProject: any;
let bobProject: any;
let credTypeid = '';
let convId = '';

const instanceDir = (name: string) => path.join(os.homedir(), '.flow', 'instances', name);
const envFile = (project: any) => path.join(project.fs_storage_mount_path, '.env.local');
const readEnv = (project: any): Record<string, string> => {
  const file = envFile(project);
  if (!existsSync(file)) return {};
  return Object.fromEntries(
    readFileSync(file, 'utf-8').split('\n').filter((l) => l.includes('=')).map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')];
    }),
  );
};

async function ok(p: Promise<any>, what: string) {
  const body = await p;
  if (!/success/i.test(String(body?.status))) throw new Error(`${what}: ${JSON.stringify(body)}`);
  return body.data;
}

async function firstProject(inst: ResolvedInstance) {
  const rows: any[] = (await jsonApi(inst.apiUrl, '/graph/project')).data ?? [];
  const found = rows.find((p) => p.fs_storage_mount_path?.includes(`/instances/${inst.name}/`)) ?? rows[0];
  if (!found) throw new Error(`no project on ${inst.name}`);
  return found;
}

const sealed = (inst: ResolvedInstance, verb: string, body: any, headers: Record<string, string> = {}) =>
  fetch(`${inst.apiUrl}/api/v1${CREDS}/sealed/${verb}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  }).then(async (r) => ({ http: r.status, ...(await r.json()) }));

const incoming = (inst: ResolvedInstance) => jsonApi(inst.apiUrl, `${CREDS}/sealed/incoming?conversation_id=${convId}`);
const sent = (inst: ResolvedInstance) => jsonApi(inst.apiUrl, `${CREDS}/sealed/sent?conversation_id=${convId}`);
const hubMessages = async (token: string) =>
  ((await hubJson(token, `/graph/conversation/${convId}/flow_message`)) as any[]) ?? [];

beforeAll(async () => {
  const hub = await hubAvailable();
  if (!hub.ok) return void (skipReason = hub.reason ?? 'hub unreachable');
  if (!instanceAvailable(INST_1) || !instanceAvailable(INST_2)) {
    return void (skipReason = `launch ${INST_1} + ${INST_2} via scripts/instance_ctl.sh`);
  }
  const [a, b] = [await getAliceCreds(), await getBobCreds()];
  if (!a || !b) return void (skipReason = 'set ALICE_EMAIL/ALICE_PW and BOB_EMAIL/BOB_PW');
  alice = await getInstance(INST_1);
  bob = await getInstance(INST_2);
  aliceHub = await hubLogin(a.email, a.password);
  bobHub = await hubLogin(b.email, b.password);

  // Both installs can receive (another suite may have turned Bob's off), then publish their device key (sign-in
  // does this too; explicit here so the test does not race it).
  for (const name of [INST_1, INST_2]) {
    const prefs = path.join(instanceDir(name), 'preferences.json');
    const cur = existsSync(prefs) ? JSON.parse(readFileSync(prefs, 'utf-8')) : {};
    writeFileSync(prefs, JSON.stringify({ ...cur, 'preferences.sharing.secure_receiving': true }));
  }
  for (const inst of [alice, bob]) {
    const pub = await ok(sealed(inst, 'publish', {}), `publish ${inst.name}`);
    expect(pub.key_id).toBeTruthy();
  }

  // The same credential declared on both sides; only Alice holds values.
  aliceProject = await firstProject(alice);
  bobProject = await firstProject(bob);
  const manifest = {
    name: CRED, title: 'Acme Gmail (e2e)', setup: 'manual',
    vars: { [ADDR]: {}, [PASS]: {} },
  };
  const saved = await ok(postApi(alice.apiUrl, `${CREDS}/save`, {
    scope: 'project', project_id: aliceProject.id, manifest,
    values: { [ADDR]: 'sales@acme-e2e.test', [PASS]: SECRET },
  }), 'alice declares + sets');
  credTypeid = saved.typeid;
  await ok(postApi(bob.apiUrl, `${CREDS}/save`, { scope: 'project', project_id: bobProject.id, manifest }), 'bob declares');

  // A conversation Alice shares with Bob (the share's own path); Bob syncs it.
  const conv = trackForCleanup(new alice.sdk.Conversation({ title: testEntityName('secure-share') }));
  await conv.save();
  await conv.share([bob.email]);
  convId = conv.id;
  await syncAssignedConversation(bob, convId);
}, 120_000);

beforeEach((context: any) => {
  if (skipReason) context.skip();
});

describe('secured transfer through the real hub', () => {
  it('Alice sees Bob can receive — through the conversation members action only', async () => {
    const receivers = await ok(jsonApi(alice.apiUrl, `${CREDS}/sealed/receivers?conversation_id=${convId}`), 'receivers');
    expect(receivers[bobHub.user.id]).toBe('ok');
    // A stranger to the conversation reaches no keys (charlie = a fresh hub user in no shared entity).
    const stranger = await hubLogin(`stranger-${Date.now()}@local.test`, 'stranger-pw-1234').catch(() => null);
    if (stranger) {
      const r = await fetch(`${process.env.FLOWPAD_HUB_URL ?? 'http://localhost:8093'}/api/v1/graph/conversation/${convId}/list_members/device_keys`,
        { headers: { Authorization: `Bearer ${stranger.token}` } });
      expect([401, 403, 404]).toContain(r.status);
    }
  });

  it('a worker / CLI request cannot seal (the gate header marks it)', async () => {
    const refused = await sealed(alice, 'seal', { typeid: credTypeid, conversation_id: convId, recipients: [bobHub.user.id] },
      { 'x-cookie-gate': 'from-a-script' });
    expect(refused.http).toBe(403);
    expect(refused.data?.error_code).toBe('human_only');
  });

  it('share → Bob fills in → connected; Alice sees filled; the envelope leaves the hub; no plaintext anywhere', async () => {
    const out = await ok(sealed(alice, 'seal', { typeid: credTypeid, conversation_id: convId, recipients: [bobHub.user.id] }), 'seal');
    expect(out.sealed_for).toEqual([bobHub.user.id]);
    expect(out.variables).toEqual([ADDR, PASS].sort());

    // What the hub holds: an opaque envelope, no value, no credential/variable names.
    const onHub = await hubMessages(bobHub.token);
    const env = onHub.find((m) => m.kind === 'sealed_value');
    expect(env?.metadata?.sealed_value?.ciphertext).toBeTruthy();
    const hubText = JSON.stringify(onHub);
    for (const leak of [SECRET, 'sales@acme-e2e.test', ADDR, PASS, CRED]) expect(hubText).not.toContain(leak);

    const card = await pollUntil(async () => {
      const rows: any[] = (await incoming(bob)).data ?? [];
      return rows.find((c) => c.transfer_id === out.transfer_id && c.state === 'pending') ?? null;
    }, 20_000, 'Bob sees the pending card');
    expect(card.credential_name).toBe(CRED);
    expect(JSON.stringify(card)).not.toContain(SECRET);

    const filled = await ok(sealed(bob, 'fill', { conversation_id: convId, message_id: card.message_id, project_id: bobProject.id }), 'fill');
    expect(filled.filled).toEqual([ADDR, PASS].sort());
    expect(readEnv(bobProject)[PASS]).toBe(SECRET);

    const status = await pollUntil(async () => {
      const rows: any[] = (await sent(alice)).data ?? [];
      const row = rows.find((r) => r.transfer_id === out.transfer_id);
      return row?.recipients?.[bobHub.user.id] === 'filled' ? row : null;
    }, 20_000, 'Alice sees filled');
    expect(status.recipients).toEqual({ [bobHub.user.id]: 'filled' });
    await pollUntil(async () => ((await hubMessages(aliceHub.token)).some((m) => m.metadata?.sealed_value?.transfer_id === out.transfer_id) ? null : true),
      20_000, 'envelope removed from the hub');

    // No plaintext in either backend's log.
    for (const inst of [alice, bob]) {
      const log = path.join(instanceDir(inst.name), 'launcher-backend.log');
      if (existsSync(log)) expect(readFileSync(log, 'utf-8')).not.toContain(SECRET);
    }
  });

  it('Bob declines: nothing written, Alice sees declined', async () => {
    const before = readEnv(bobProject)[PASS];
    const out = await ok(sealed(alice, 'seal', { typeid: credTypeid, conversation_id: convId, recipients: [bobHub.user.id] }), 'seal 2');
    const card = await pollUntil(async () => ((await incoming(bob)).data ?? []).find((c: any) => c.transfer_id === out.transfer_id && c.state === 'pending') ?? null,
      20_000, 'second card');
    await ok(postApi(bob.apiUrl, `${CREDS}/sealed/decline`, { conversation_id: convId, message_id: card.message_id }), 'decline');
    expect(readEnv(bobProject)[PASS]).toBe(before);
    await pollUntil(async () => ((await sent(alice)).data ?? []).find((r: any) => r.transfer_id === out.transfer_id && r.recipients?.[bobHub.user.id] === 'declined') ?? null,
      20_000, 'Alice sees declined');
  });

  it('an envelope tampered on the hub, or re-posted by another member, is refused', async () => {
    const out = await ok(sealed(alice, 'seal', { typeid: credTypeid, conversation_id: convId, recipients: [bobHub.user.id] }), 'seal 3');
    const genuine = (await hubMessages(bobHub.token)).find((m) => m.metadata?.sealed_value?.transfer_id === out.transfer_id);
    // Tampered: the same envelope with a later expiry, posted straight to the hub (as Alice — the hub stamps her).
    const tampered = { ...genuine.metadata.sealed_value, expires_at: '2999-01-01T00:00:00+00:00', transfer_id: `${out.transfer_id}-t` };
    await hubJson(aliceHub.token, `/graph/conversation/${convId}/add_message`, { text: '', kind: 'sealed_value', metadata: { sealed_value: tampered } });
    // Re-posted by Bob as if it were his (the hub stamps BOB as sender; the envelope says Alice).
    await hubJson(bobHub.token, `/graph/conversation/${convId}/add_message`, { text: '', kind: 'sealed_value', metadata: { sealed_value: { ...genuine.metadata.sealed_value, transfer_id: `${out.transfer_id}-r` } } });

    const cards: any[] = await pollUntil(async () => {
      const rows: any[] = (await incoming(bob)).data ?? [];
      return rows.some((c) => c.transfer_id === `${out.transfer_id}-t`) && rows.some((c) => c.transfer_id === `${out.transfer_id}-r`) ? rows : null;
    }, 20_000, 'both forgeries visible');
    expect(cards.find((c) => c.transfer_id === `${out.transfer_id}-t`).state).toBe('bad_signature');
    expect(['unknown_sender', 'wrong_sender', 'bad_signature']).toContain(cards.find((c) => c.transfer_id === `${out.transfer_id}-r`).state);
    // and the genuine one still opens
    expect(cards.find((c) => c.transfer_id === out.transfer_id).state).toBe('pending');
  });

  it('Bob rotates his device key: in-flight values still open, a new share is sealed to the new key', async () => {
    const inFlight = await ok(sealed(alice, 'seal', { typeid: credTypeid, conversation_id: convId, recipients: [bobHub.user.id] }), 'seal 4');
    const oldKey = (await ok(jsonApi(bob.apiUrl, `${CREDS}/sealed/device`), 'device')).key_id;
    const rotated = await ok(sealed(bob, 'publish', { rotate: true }), 'rotate');
    expect(rotated.key_id).not.toBe(oldKey);

    const fresh = await ok(sealed(alice, 'seal', { typeid: credTypeid, conversation_id: convId, recipients: [bobHub.user.id] }), 'seal 5');
    expect(fresh.sealed_for).toEqual([bobHub.user.id]);  // Alice followed the countersigned rotation, no prompt
    // Every copy each envelope carries (Bob may have more than one device on record); the old key sealed the
    // in-flight one, the rotated key the fresh one.
    const keysOf = async (tid: string) => (await hubMessages(bobHub.token))
      .find((m) => m.metadata?.sealed_value?.transfer_id === tid)
      ?.metadata.sealed_value.recipients.map((r: any) => r.key_id) ?? [];
    expect(await keysOf(inFlight.transfer_id)).toContain(oldKey);
    expect(await keysOf(fresh.transfer_id)).toContain(rotated.key_id);

    const rows: any[] = await pollUntil(async () => {
      const r: any[] = (await incoming(bob)).data ?? [];
      return [inFlight.transfer_id, fresh.transfer_id].every((t) => r.some((c) => c.transfer_id === t)) ? r : null;
    }, 20_000, 'both cards');
    for (const t of [inFlight.transfer_id, fresh.transfer_id]) expect(rows.find((c) => c.transfer_id === t).state).toBe('pending');
    const card = rows.find((c) => c.transfer_id === inFlight.transfer_id);
    await ok(sealed(bob, 'fill', { conversation_id: convId, message_id: card.message_id, project_id: bobProject.id }), 'fill old-key value');
    expect(readEnv(bobProject)[PASS]).toBe(SECRET);
  });
});
