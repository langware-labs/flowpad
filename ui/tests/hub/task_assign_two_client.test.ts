/**
 * Task assignment across TWO instances — JIRA-like, and nothing else.
 *
 *   alice: create a task (title + body) in her project
 *   alice: assign it to bob
 *   bob:   the task IS on his machine — assigned to him, with the body
 *   bob:   he moves it to in_progress; alice sees that
 *
 * The point of this file is what it REFUSES to do. Bob never accepts an
 * invitation, never opens a conversation, never installs an attachment, and
 * never calls a sync/fetch helper to go looking. Assignment alone must put the
 * task on his board — the same way assigning a JIRA issue does. Any test step
 * that "helps" the task arrive would defeat the whole purpose, so the only
 * thing bob does before asserting is wait.
 *
 * This is a SPEC, not a regression guard: at the time of writing the only
 * delivery channels are invitation→accept and conversation-chip→install, and
 * the group-task module states plainly that "there is no hub→local push for
 * plain tasks". The arrival assertion is therefore expected to fail until a
 * direct assign→deliver path exists. It is written to fail at exactly that
 * line, with everything before it green, so the failure names the gap.
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

let taskId = '';

const getApi = (apiUrl: string, p: string) => fetch(`${apiUrl}/api/v1${p}`).then((r) => r.json());

/**
 * Every task row bob's own backend holds, read past the realm query cache.
 * Deliberately the ONLY thing this test does on bob's side: no
 * fetchConversations, no conversation/invitation sync, no accept, no install.
 * If a row shows up here, delivery did it.
 */
async function bobTasks(): Promise<any[]> {
  return ((await bob.sdk.Task.query(
    new bob.sdk.QueryRequest({ type: 'task', query: {}, name: 'bob tasks (assign spec)' }),
    true,
  ).catch(() => [])) ?? []) as any[];
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

describe('task assignment — alice assigns, it lands on bob', () => {
  it('alice creates a task with a title and a body', async () => {
    const task = trackForCleanup(new alice.sdk.Task({ title: TITLE, description: BODY }));
    await task.save();
    taskId = task.id;

    const mine = await getApi(alice.apiUrl, `/graph/task/${taskId}?expand=blobs`);
    expect(mine?.data?.title).toBe(TITLE);
    expect(mine?.data?.description).toContain(token);
  });

  it('alice assigns it to bob', async () => {
    const assigned = await postApi(alice.apiUrl, `/graph/task/${taskId}/create-group-task`, {
      members: [{ email: bob.email, name: 'Bob' }],
    });
    expect(assigned.status, JSON.stringify(assigned)).toBe('SUCCESS');
    expect(assigned.data.created, 'bob is the assignee').toContain(bob.email);
  });

  it('the task is on bob — no accept, no conversation, no install', async () => {
    // His task is the one assigned to HIM: the member task under the assigned
    // parent. The parent rides along as the read-only context (it carries the
    // body and every display field) but is not the row he owns.
    const landed = await pollUntil(
      async () => (await bobTasks()).find((t) => t.parent_id === taskId) ?? null,
      20_000,
      'assigned task delivered to bob without him doing anything',
    );

    expect(landed.assignee, 'it is assigned to him').toBe(bob.email);
    expect(landed.title).toBe(TITLE);
    expect(landed.status, 'a freshly assigned task is open').toBe('to_do');

    // Nothing was asked of bob to get here: assert the mechanisms this feature
    // must NOT depend on left no trace on his side.
    const invitations: any[] = await (bob.sdk.Invitation as any)
      .query({ query: {} }, true)
      .catch(() => []);
    const gating = invitations.filter(
      (inv) => !inv.accepted && (inv.target_id === taskId || (inv.target_url_path || '').includes(taskId)),
    );
    expect(gating, 'delivery must not be gated behind an invitation').toHaveLength(0);
  });

  it('bob can read the body alice wrote', async () => {
    const withBody = await pollUntil(
      async () => {
        const t = await getApi(bob.apiUrl, `/graph/task/${taskId}?expand=blobs`);
        return t?.data?.description ? t.data : null;
      },
      15_000,
      'the task body is readable on bob',
    );
    expect(withBody.description).toContain(token);
  });

  it("bob moves it to in_progress and alice sees it", async () => {
    const mine = (await bobTasks()).find((t) => t.parent_id === taskId);
    expect(mine, 'precondition: bob holds the task').toBeTruthy();
    mine.status = 'in_progress';
    await mine.save();

    const seen = await pollUntil(
      async () => {
        await postApi(alice.apiUrl, `/graph/task/${taskId}/sync-group`, {});
        const rows = (await getApi(alice.apiUrl, `/graph/task/${mine.id}`))?.data;
        return rows?.status === 'in_progress' ? rows : null;
      },
      20_000,
      "alice sees bob's progress",
    );
    expect(seen.assignee).toBe(bob.email);
  });
});
