/**
 * Every share is a message in ONE 1:1 conversation between the person who shared and the person
 * shared with — real hub, two real users, the recipient's real backend.
 *
 * alice (INST_1) creates two sandboxes on the hub (create only: nothing is launched, nothing bills)
 * and shares both with bob (INST_2):
 *   1. bob's backend holds ONE conversation with alice that carries invites, holding two invite
 *      messages — one per machine — each naming its machine;
 *   2. with the hub's auto-accept on (its default), both read `accepted`;
 *   3. alice removes bob from one machine → that invite reads `revoked`; the conversation and the
 *      other invite stay.
 *
 *   scripts/instance_ctl.sh launch inv-1 --hub http://localhost:<hub> && scripts/instance_ctl.sh launch inv-2 --hub http://localhost:<hub>
 *   cd ui && env -u LOCAL_SERVER_PORT FLOWPAD_HUB_URL=http://localhost:<hub> SHARE_INST_1=inv-1 SHARE_INST_2=inv-2 \
 *     FLOW_INSTANCE=inv-1 npx vitest run --project hub share_invite_thread
 * Skips when the hub or the instances aren't up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testEntityName } from '../_cleanup';
import { hubAvailable, hubJson, hubLogin } from './_hub';
import { pollUntil } from './_matrix';
import {
  HUB_INST_1 as INST_1,
  HUB_INST_2 as INST_2,
  getInstance,
  instanceAvailable,
  postApi,
  queryConversationMessages,
  resolveLaunchedInstance,
  type LaunchedInstance,
  type ResolvedInstance,
} from './_instances';

let skipReason: string | null = null;
let alice: LaunchedInstance;
let bob: ResolvedInstance;
let aliceToken = '';
let bobUserId = '';
const machines: string[] = [];

beforeAll(async () => {
  const hub = await hubAvailable();
  if (!hub.ok) return void (skipReason = hub.reason ?? 'hub unreachable');
  if (!instanceAvailable(INST_1) || !instanceAvailable(INST_2)) {
    return void (skipReason = `launch ${INST_1} + ${INST_2} via scripts/instance_ctl.sh`);
  }
  alice = resolveLaunchedInstance(INST_1)!;
  bob = await getInstance(INST_2);
  aliceToken = (await hubLogin(alice.email, alice.env.FLOWPAD_CLOUD_USER_PASSWORD)).token;
  bobUserId = (await hubLogin(bob.email, bob.env.FLOWPAD_CLOUD_USER_PASSWORD)).user.id;
}, 60_000);

afterAll(async () => {
  for (const id of machines) await hubJson(aliceToken, `/graph/compute_node/${id}`, undefined, 'DELETE').catch(() => undefined);
});

async function createSandbox(): Promise<string> {
  const node = await hubJson(aliceToken, '/graph/compute_node', {
    name: testEntityName('machine'),
    node_provider: 'e2b',
    node_size: 'sm',
    node_config: { flavor: 'workspace' },
  });
  machines.push(node.id);
  return node.id;
}

const share = (nodeId: string) =>
  hubJson(aliceToken, `/graph/compute_node/${nodeId}/members`, {
    recipient_email: bob.email,
    // The role the Machines page's Share grants (`SANDBOX_SHARE_ROLE`).
    invitation_targets: [{ typeid: `compute_node-${nodeId}`, roles: ['admin'] }],
  });

/** bob's local view: his conversations that carry invites, and the invite messages in them. */
async function bobInvites(): Promise<{ conversations: any[]; invites: any[] }> {
  await postApi(bob.apiUrl, '/graph/conversation-list');
  const conversations = ((await bob.sdk.Conversation.query(
    new bob.sdk.QueryRequest({ type: 'conversation', query: { carries_invite: true }, scope: [] }),
    /* invalidate */ true,
  )) ?? []) as any[];
  const invites: any[] = [];
  for (const c of conversations) {
    await postApi(bob.apiUrl, '/graph/conversation-message-sync', { conversation_id: c.id });
    for (const m of await queryConversationMessages(bob, c.id)) if (m.invite) invites.push({ ...m.invite, conversation_id: c.id });
  }
  return { conversations, invites };
}

describe('a share is a message in the 1:1 conversation', () => {
  it('two machines → one conversation, two accepted invites; a removal reads revoked', async (ctx) => {
    if (skipReason) return ctx.skip(skipReason);
    const [first, second] = [await createSandbox(), await createSandbox()];
    await share(first);
    await share(second);

    const both = await pollUntil(
      async () => {
        const v = await bobInvites();
        const ours = v.invites.filter((i) => machines.includes(i.target_id));
        return ours.length === 2 ? { ...v, ours } : null;
      },
      20_000,
      'two invite messages on bob',
    );
    expect(new Set(both.ours.map((i) => i.conversation_id)).size).toBe(1);
    expect(both.ours.map((i) => i.target_type)).toEqual(['compute_node', 'compute_node']);
    expect(both.ours.every((i) => i.state === 'accepted')).toBe(true);

    await hubJson(aliceToken, `/graph/compute_node/${first}/members`, { user_id: bobUserId }, 'DELETE');

    const after = await pollUntil(
      async () => {
        const v = await bobInvites();
        const removed = v.invites.find((i) => i.target_id === first);
        return removed?.state === 'revoked' ? v : null;
      },
      20_000,
      'the removed share reads revoked on bob',
    );
    const kept = after.invites.filter((i) => machines.includes(i.target_id));
    expect(kept).toHaveLength(2);
    expect(kept.find((i) => i.target_id === second)?.state).toBe('accepted');
  });
});
