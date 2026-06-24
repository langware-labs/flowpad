/**
 * The payoff: TWO real SDK clients in ONE process — one per instance, each in
 * its own module realm ("each instance == its own window").
 *
 * dev-1 and dev-2 are separate, freshly-evaluated `@sdk` graphs pointed at
 * separate backends (own dataManager + apiClient + connectionManager + config).
 * There is no shared `currentSdk` pointer and no `.run()` scope — each realm's
 * entity classes (`dev1.sdk.Skill`, `dev2.sdk.Conversation`) route to their own
 * backend intrinsically. This is impossible with a single shared module-singleton
 * SDK in one process, which is why the existing two-client coverage is split
 * across `matrix.alice` / `matrix.bob` over a `/tmp` rendezvous + two processes.
 *
 * Test A proves isolation (the realm separation itself). Test B is the original
 * use case end-to-end, now in-process: dev-1 creates + shares a skill
 * conversation via the real SDK share path (mirrors `matrix.alice`), and dev-2's
 * SDK client discovers + accepts the invitation and materialises the shared
 * conversation as a remote entity (mirrors `matrix.bob`).
 *
 * Requires the local hub (8093) + dev-1/dev-2 launched via
 * `scripts/instance_ctl.sh launch dev-1 && … dev-2`. Skips otherwise.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hubAvailable } from './_hub';
import { pollUntil } from './_matrix';
import { testEntityName, trackForCleanup } from '../_cleanup';
import {
  findPendingInvitation,
  getInstance,
  instanceAvailable,
  type ResolvedInstance,
} from './_instances';

let skipReason: string | null = null;
let dev1: ResolvedInstance;
let dev2: ResolvedInstance;

beforeAll(async () => {
  const hub = await hubAvailable();
  if (!hub.ok) return void (skipReason = hub.reason ?? 'hub unreachable');
  if (!(await instanceAvailable('dev-1')) || !(await instanceAvailable('dev-2'))) {
    return void (skipReason = 'launch dev-1 + dev-2 via scripts/instance_ctl.sh');
  }
  // Order matters: each call re-evaluates the SDK graph into its own realm.
  dev1 = await getInstance('dev-1');
  dev2 = await getInstance('dev-2');
}, 30_000);

beforeEach((context: any) => {
  if (skipReason) context.skip();
});

const post = (apiUrl: string, p: string, body?: unknown) =>
  fetch(`${apiUrl}/api/v1${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).then((r) => r.json());

describe('two SDK clients in one process (realm per instance)', () => {
  it('isolated realms + backends — a skill on dev-1 does not exist on dev-2', async () => {

    // Distinct realms: different namespaces, singletons, and backends.
    expect(dev1.sdk).not.toBe(dev2.sdk);
    expect(dev1.sdk.dataManager).not.toBe(dev2.sdk.dataManager);
    expect(dev1.sdk.apiClient).not.toBe(dev2.sdk.apiClient);
    expect(dev1.apiUrl).not.toBe(dev2.apiUrl);

    // Create a skill on dev-1 via ITS realm's entity class; it resolves on dev-1.
    const skill = trackForCleanup(await dev1.sdk.Skill.create(testEntityName('skill')));
    expect(skill.id).toBeTruthy();
    const onDev1 = await dev1.sdk.Skill.getById(skill.id!).catch(() => null);
    expect(onDev1?.id).toBe(skill.id);

    // The same id on dev-2 (different backend, different realm) is NOT found.
    const onDev2 = await dev2.sdk.Skill.getById(skill.id!).catch(() => null);
    expect(onDev2).toBeFalsy();
  });

  it('dev-1 shares a skill conversation; dev-2 SDK client accepts + receives it', async () => {

    // ── dev-1 (sender): real SDK share path (mirrors matrix.alice). ──
    const skill = trackForCleanup(await dev1.sdk.Skill.create(testEntityName('skill')));
    const conv = trackForCleanup(new dev1.sdk.Conversation({ title: testEntityName('conv') }));
    await conv.save();
    await conv.share([dev2.email]);
    expect(conv.remote).toBe(true);

    // Attach the skill via the production send path (`message` + `asset_references`)
    // and stage the body bundle on the hub. (Raw HTTP: the SDK `addMessage`
    // sends `{text}`, which this backend's add_message rejects — a separate
    // SDK↔backend contract drift, out of scope here.)
    const fmId = (
      await post(dev1.apiUrl, `/graph/conversation/${conv.id}/add_message`, {
        message: 'a skill for you',
        asset_references: [`skill-${skill.id}`],
      })
    ).data.flow_message_id as string;
    const upload = await post(dev1.apiUrl, `/graph/flow_message/${fmId}/upload_body`, {});
    // The skill bundle is staged READY on the hub — the sender half works.
    expect(upload.data?.body_status).toBe('ready');

    // dev-1's own realm resolves the skill it created.
    expect((await dev1.sdk.Skill.getById(skill.id!).catch(() => null))?.id).toBe(skill.id);

    // ── dev-2 (receiver): discover + accept the invitation (mirrors matrix.bob).
    //    The invitation has to sync down from the hub first — poll for it. ──
    const invitation = await pollUntil(
      () => findPendingInvitation(dev2, conv.id!),
      20_000,
      'pending invitation on dev-2',
    );
    const accepted = await dev2.sdk.acceptInvitation({ invitation_id: invitation.id! });
    if (accepted.conversation_id) expect(accepted.conversation_id).toBe(conv.id);

    // Post-accept the conversation is materialised on dev-2 as a remote entity —
    // two SDK clients exchanging over one hub in a single process, each in its
    // own realm.
    const received = await pollUntil(
      () => dev2.sdk.Conversation.getById(conv.id!),
      10_000,
      'conversation materialised on dev-2',
    );
    expect(received.id).toBe(conv.id);
    expect((received as any).remote).toBe(true);
  });
});
