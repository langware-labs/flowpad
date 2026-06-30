/**
 * Scenario: doc_comment_delete_sync
 * Source: ui/tests/manual_regression/collaboration/doc_comment_delete_sync.md
 * ScenarioId: 7dbcead1-46c8-434c-96d2-eac23050729f
 *
 * Browser/Playwright tier — deleting a shared comment child removes it for the
 * peer, both directions. Each delete is first validated PRESENT ON BOTH SIDES.
 * See _doc_comment_collab.ts for the rig.
 */
import { test, expect } from '@playwright/test';
import {
  ALICE_API, BOB_API, cleanup, mkComment, newRig, rigUnavailable, rmComment,
  setupSharedConversation, waitAbsent, waitText, type Rig,
} from './_doc_comment_collab';

test('binding criterion: present on BOTH sides, then removed for the peer [doc_comment_delete_sync]', async () => {
  test.setTimeout(60_000);
  const rq = await newRig();
  const skip = await rigUnavailable(rq);
  test.skip(!!skip, skip ?? '');

  let rig: Rig | undefined;
  try {
    rig = await setupSharedConversation(rq);
    const { convId } = rig;

    // A→B: present on alice AND bob, then alice deletes → gone for bob.
    const a = await mkComment(rq, ALICE_API, convId, 'to-delete-a', 3);
    expect(await waitText(rq, ALICE_API, convId, a, 'to-delete-a'), 'delete setup: present on alice').toBeTruthy();
    expect(await waitText(rq, BOB_API, convId, a, 'to-delete-a'), 'delete setup: present on bob').toBeTruthy();
    await rmComment(rq, ALICE_API, a); // server auto-propagates child_deleted (no Hub-Reflect)
    expect(await waitAbsent(rq, BOB_API, convId, a), 'delete A→B: comment disappears for bob').toBe(true);

    // B→A: present on bob AND alice, then bob deletes → gone for alice.
    const b = await mkComment(rq, BOB_API, convId, 'to-delete-b', 4);
    expect(await waitText(rq, BOB_API, convId, b, 'to-delete-b'), 'delete setup: present on bob').toBeTruthy();
    expect(await waitText(rq, ALICE_API, convId, b, 'to-delete-b'), 'delete setup: present on alice').toBeTruthy();
    await rmComment(rq, BOB_API, b);
    expect(await waitAbsent(rq, ALICE_API, convId, b), 'delete B→A: comment disappears for alice').toBe(true);
  } finally {
    if (rig) await cleanup(rq, rig.convId);
    await rq.dispose();
  }
});
