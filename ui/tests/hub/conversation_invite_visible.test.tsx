/**
 * Hub: an assigned conversation is visible immediately (SDK + hook).
 *
 * Pure SDK / hooks — no component mount, no router, no API stub/override:
 *   1. Alice creates a Conversation and ``share([invitee])`` — pushes it to the
 *      hub and assigns the recipient immediately.
 *   2. SDK ``getMembers`` proves the recipient is an approved member.
 *   3. ``renderHook(useEntity(convTypeId))`` — the exact hook the conversation
 *      UI uses to load its conversation — resolves THIS conversation (same id +
 *      title). That hook resolving proves the conversation is seen.
 *
 * Gated like the sibling hub tests: skips when the hub is down or the local
 * backend isn't cloud-logged-in.
 */
import { config, dataContext, getMembers, TypeId } from '@sdk';
import { Conversation } from '@sdk/entities/conversation';
import { useEntity } from '@sdk/react/hooks';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { testEntityName, trackForCleanup } from '../_cleanup';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';
import {
  getAliceCreds,
  getBobCreds,
  hubAvailable,
  localBackendIsCloudLoggedIn,
} from './_hub';

let skipReason: string | null = null;
let inviteeEmail = '';

beforeAll(async () => {
  const hub = await hubAvailable();
  if (!hub.ok) { skipReason = hub.reason ?? 'hub unreachable'; return; }
  if (!(await localBackendIsCloudLoggedIn(config.SERVER_URL))) {
    skipReason = 'local backend is not cloud-logged-in (run `flowpad cloud login`)';
    return;
  }
  const alice = await getAliceCreds();
  if (!alice) {
    skipReason = 'missing ALICE_EMAIL/ALICE_PW';
    return;
  }
  // Assign a real co-user when configured, else a synthetic address.
  const bob = await getBobCreds();
  inviteeEmail = bob?.email ?? `pending-invitee-${Date.now()}@local.test`;
});

const signupInfo = getTestSignupInfo();

beforeEach(async (context: any) => {
  if (skipReason) context.skip();
  await apiTestSetup(signupInfo, context.task.name);
});

describe('hub: assigned conversation is visible immediately (SDK + hook)', () => {
  it('useEntity resolves the conversation after immediate assignment', async () => {
    // 1. Create + share. The recipient is assigned at the hub immediately.
    const title = testEntityName('conv');
    const conv = trackForCleanup(new Conversation({ title }));
    expect(conv.id).toBeTruthy();
    await conv.save();
    await conv.share([inviteeEmail]);
    expect(conv.remote).toBe(true);

    const convTypeId = new TypeId(Conversation.type, conv.id);

    // 2. Premise check via SDK: the invitee is an approved member. No raw HTTP —
    //    getMembers is the SDK's roster surface. (The
    //    roster row carries hub fields `user_email` + `status` that the lossy
    //    `Participant` type doesn't declare, so read them off the raw object.)
    const roster = (await getMembers(convTypeId)) as Array<
      { email?: string | null; user_email?: string | null; role?: string | null; status?: string | null }
    >;
    const inviteeRow = roster.find((m) => {
      const e = (m.user_email ?? m.email ?? '').toLowerCase();
      return e === inviteeEmail.toLowerCase();
    });
    expect(inviteeRow).toBeTruthy();
    expect(inviteeRow?.status).toBe('approved');
    expect(inviteeRow?.role).toBe('member');

    // 3. The conversation is *seen*: useEntity — the hook the conversation UI
    //    uses to load its conversation — resolves THIS conversation by id.
    //    Same id + title proves it's the one we
    //    just shared, not a stale/empty hit.
    const { result } = renderHook(() => useEntity<Conversation>(convTypeId));
    await waitFor(
      () => {
        expect(result.current.data?.id).toBe(conv.id);
        expect(result.current.data?.title).toBe(title);
      },
      { timeout: 10_000, interval: 250 },
    );

    void dataContext;
  });
});
