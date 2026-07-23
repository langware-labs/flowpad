/**
 * Task assignment across TWO instances via the real hub — the delivery chain
 * the vibe "ask for assistance" flow rides:
 *
 *   alice: create task (title + body) → assign to bob (group-of-one)
 *   bob:   the INVITATION lands in his local store in real time — the hub WS
 *          frame nudges `handle_invitation_sync` (hub_bridge._handle_invitation_op);
 *          the test never calls fetchConversations / conversation-sync, so the
 *          row appearing IS the push proof
 *   bob:   accept → his member task + the parent mirror (title AND body)
 *          materialize
 *   bob:   status change → alice's `sync-group` pulls it back onto her mirror
 *
 * What this deliberately does NOT claim: the task row itself appearing on bob
 * with zero action — task freshness is pull-based by design (group_task_action
 * docstring); the real-time surface is the invitation.
 *
 * Requires the local hub + dev-1/dev-2 launched via
 *   scripts/instance_ctl.sh launch dev-1 && … dev-2
 * Skips otherwise.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { trackForCleanup } from '../_cleanup';
import { hubAvailable } from './_hub';
import {
  HUB_INST_1 as INST_1,
  HUB_INST_2 as INST_2,
  getInstance,
  instanceAvailable,
  postApi,
  type ResolvedInstance,
} from './_instances';
import { pollUntil } from './_matrix';

let skipReason: string | null = null;
let alice: ResolvedInstance;
let bob: ResolvedInstance;

const token = `ta-${randomUUID()}`;
const TITLE = `assign me ${token.slice(-8)}`;
const BODY = `Please look into the login flow.\n\n${token}`;

// Cross-step state — the its run sequentially (singleThread) and each later
// step is meaningless without the earlier one, so failures cascade on purpose.
let parentId = '';
let childId = '';
let invitationId = '';

const getApi = (apiUrl: string, p: string) => fetch(`${apiUrl}/api/v1${p}`).then((r) => r.json());

/** Bob's LOCAL invitation rows (cache-invalidated). No fetchConversations, no
 *  invitation-sync — nothing here asks the hub; only the backend's own WS-nudged
 *  mirror can make the row appear. */
async function bobLocalInvitations(): Promise<any[]> {
  return ((await (bob.sdk.Invitation as any).query({ query: {} }, true).catch(() => [])) ?? []) as any[];
}

beforeAll(async () => {
  const hub = await hubAvailable();
  if (!hub.ok) return void (skipReason = hub.reason ?? 'hub unreachable');
  if (!instanceAvailable(INST_1) || !instanceAvailable(INST_2)) {
    return void (skipReason = `launch ${INST_1} + ${INST_2} via scripts/instance_ctl.sh`);
  }
  alice = await getInstance(INST_1);
  bob = await getInstance(INST_2);
}, 30_000);

beforeEach((context: any) => {
  if (skipReason) context.skip();
});

describe('task assignment — alice → bob across two instances', () => {
  it('alice creates a task with title + body and assigns it to bob', async () => {
    const task = trackForCleanup(new alice.sdk.Task({ title: TITLE, description: BODY }));
    await task.save();
    parentId = task.id;

    // Group-of-one: the delivery model with real ownership + status sync-back.
    const created = await postApi(alice.apiUrl, `/graph/task/${parentId}/create-group-task`, {
      members: [{ email: bob.email, name: 'Bob' }],
    });
    expect(created.status, JSON.stringify(created)).toBe('SUCCESS');
    expect(created.data.created, 'bob is a fresh member').toContain(bob.email);
    expect(created.data.children, JSON.stringify(created.data)).toHaveLength(1);
    childId = String(created.data.children[0]).split('-').slice(1).join('-');
  });

  it('the invitation reaches bob in real time — no client refresh', async () => {
    const invitation = await pollUntil(
      async () => {
        const all = await bobLocalInvitations();
        return (
          all.find(
            (inv) =>
              !inv.accepted &&
              ((inv.target_url_path || '').includes(childId) ||
                (inv.target_url_path || '').includes(parentId) ||
                inv.target_id === childId ||
                inv.target_id === parentId),
          ) ?? null
        );
      },
      25_000,
      'assignment invitation mirrored on bob without any refresh call',
    );
    invitationId = invitation.id;
    expect(invitation.recipient_email).toBe(bob.email);
  });

  it('bob accepts and the task materializes — member task + parent title AND body', async () => {
    await bob.sdk.acceptInvitation({ invitation_id: invitationId });

    const memberTask = await pollUntil(
      async () => {
        const rows = (await bob.sdk.Task.query(
          new bob.sdk.QueryRequest({
            type: 'task',
            query: { parent_id: parentId },
            name: 'member task (assign test)',
          }),
          true,
        ).catch(() => [])) as any[];
        return rows.find((r) => r.id === childId) ?? null;
      },
      20_000,
      'member task materialized on bob',
    );
    expect(memberTask.assignee).toBe(bob.email);
    expect(memberTask.title, 'title-only clone').toBe(TITLE);
    expect(memberTask.status).toBe('to_do');

    // The body lives on the PARENT mirror (children never store display fields).
    const parent = await pollUntil(
      async () => {
        const p = await getApi(bob.apiUrl, `/graph/task/${parentId}?expand=blobs`);
        return p?.data?.description ? p.data : null;
      },
      15_000,
      "parent mirror carries the body on bob's side",
    );
    expect(parent.title).toBe(TITLE);
    expect(parent.description, 'the body reached bob').toContain(token);
  });

  it("bob's status change syncs back to alice", async () => {
    const memberTask = (await bob.sdk.Task.getById(childId)) as any;
    memberTask.status = 'in_progress';
    await memberTask.save(); // client save hub-reflects the member-owned field

    // Pull-based freshness by design: alice's UI fires sync-group on open.
    const mirrored = await pollUntil(
      async () => {
        const sync = await postApi(alice.apiUrl, `/graph/task/${parentId}/sync-group`, {});
        if (sync.status !== 'SUCCESS') return null;
        const child = await getApi(alice.apiUrl, `/graph/task/${childId}`);
        return child?.data?.status === 'in_progress' ? child.data : null;
      },
      20_000,
      "alice's member-task mirror shows bob's in_progress",
    );
    expect(mirrored.assignee).toBe(bob.email);
  });
});
