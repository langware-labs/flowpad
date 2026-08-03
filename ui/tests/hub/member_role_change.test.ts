/**
 * Two-client role-change e2e — the desktop path of the hub's role-grant
 * chokepoint (FLOWPAD-1868), end-to-end through reflection:
 *
 *   UI/SDK `setMemberRole` → local backend `PUT <conv>/members` (Hub-Reflect)
 *   → `_hub_reflect.reflect_to_hub` members-PUT branch → hub `update_membership`
 *   → `can_assign` ceiling → roster re-fetch mirrored back.
 *
 * Covers, in one flow over one shared conversation:
 *   1. owner (dev-1) changes a member's role member → editor; both clients'
 *      rosters show the new role;
 *   2. denials PROPAGATE (not silent local fallback): the member (dev-2)
 *      cannot change the owner's role, cannot self-promote — the hub 4xx
 *      surfaces as a thrown error and the roster is unchanged.
 *
 * Requires the local hub (8093) + dev-1/dev-2 launched via
 * `scripts/instance_ctl.sh launch dev-1 && … dev-2`. Skips otherwise.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hubAvailable } from './_hub';
import { pollUntil } from './_matrix';
import { testEntityName, trackForCleanup } from '../_cleanup';
import {
  HUB_INST_1 as INST_1,
  HUB_INST_2 as INST_2,
  getInstance,
  instanceAvailable,
  syncAssignedConversation,
  type ResolvedInstance,
} from './_instances';

let skipReason: string | null = null;
let dev1: ResolvedInstance;
let dev2: ResolvedInstance;

beforeAll(async () => {
  const hub = await hubAvailable();
  if (!hub.ok) return void (skipReason = hub.reason ?? 'hub unreachable');
  if (!instanceAvailable(INST_1) || !instanceAvailable(INST_2)) {
    return void (skipReason = `launch ${INST_1} + ${INST_2} via scripts/instance_ctl.sh`);
  }
  // Order matters: each call re-evaluates the SDK graph into its own realm.
  dev1 = await getInstance(INST_1);
  dev2 = await getInstance(INST_2);
}, 30_000);

beforeEach((context: any) => {
  if (skipReason) context.skip();
});

/** Fresh (cache-bypassing) roster keyed by email → lowercase role. */
async function roster(conv: any): Promise<Record<string, string>> {
  const members: any[] = await conv.fetchMembers({ cache: false });
  const out: Record<string, string> = {};
  for (const m of members) {
    if (m?.email) out[String(m.email).toLowerCase()] = String(m.role ?? '').toLowerCase();
  }
  return out;
}

describe('conversation member role change over the hub (realm per instance)', () => {
  it('owner promotes a member; denials propagate to the non-owner', async () => {
    // ── dev-1 (owner): create + share to dev-2. ──
    const conv = trackForCleanup(new dev1.sdk.Conversation({ title: testEntityName('conv') }));
    await conv.save();
    await conv.share([dev2.email]);
    expect(conv.remote).toBe(true);

    // ── dev-2 is assigned the `member` RoleRelationship at share time.
    // Recover this exact authorized conversation if its best-effort live
    // assignment frame raced or was missed. ──
    await syncAssignedConversation(dev2, conv.id);

    // Owner sees the assigned roster: dev-1 owner, dev-2 member.
    const initial = await pollUntil(
      async () => {
        const r = await roster(conv);
        return r[dev2.email.toLowerCase()] === 'member' ? r : null;
      },
      10_000,
      'dev-2 on roster as member',
    );
    expect(initial[dev1.email.toLowerCase()]).toBe('owner');

    // Resolve hub user ids from the roster (the member selector for PUT).
    const members: any[] = await conv.fetchMembers({ cache: false });
    const dev1Id = members.find((m) => String(m.email).toLowerCase() === dev1.email.toLowerCase())?.user_id;
    const dev2Id = members.find((m) => String(m.email).toLowerCase() === dev2.email.toLowerCase())?.user_id;
    expect(dev1Id).toBeTruthy();
    expect(dev2Id).toBeTruthy();

    // ── 1. Owner changes member → editor; both clients observe it. ──
    await conv.setMemberRole(dev2Id, 'editor');
    const promoted = await pollUntil(
      async () => {
        const r = await roster(conv);
        return r[dev2.email.toLowerCase()] === 'editor' ? r : null;
      },
      10_000,
      'dev-2 promoted to editor on dev-1 roster',
    );
    expect(promoted[dev1.email.toLowerCase()]).toBe('owner');

    // dev-2's own client reads the same hub-authoritative roster.
    const received = await pollUntil(
      () => dev2.sdk.Conversation.getById(conv.id).catch(() => null),
      10_000,
      'conversation materialised on dev-2',
    );
    const dev2View = await roster(received);
    expect(dev2View[dev2.email.toLowerCase()]).toBe('editor');

    // ── 2. Denials propagate (no silent local fallback). ──
    // editor may not touch the owner (target ceiling)…
    await expect((received as any).setMemberRole(dev1Id, 'member')).rejects.toThrow();
    // …and may not self-promote (assigned-role ceiling / self-ban).
    await expect((received as any).setMemberRole(dev2Id, 'admin')).rejects.toThrow();

    // Roster unchanged after both denials — hub stayed authoritative.
    const after = await roster(conv);
    expect(after[dev1.email.toLowerCase()]).toBe('owner');
    expect(after[dev2.email.toLowerCase()]).toBe('editor');
  });
});
