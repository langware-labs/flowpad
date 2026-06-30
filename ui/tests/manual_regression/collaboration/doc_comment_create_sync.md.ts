/**
 * Scenario: doc_comment_create_sync
 * Source: ui/tests/manual_regression/collaboration/doc_comment_create_sync.md
 * ScenarioId: 987c8038-f50c-464d-b817-01985ac72d5c
 *
 * Browser/Playwright tier of the generic entity-child (comment) live-sync matrix
 * — two real instances through the local hub. See _doc_comment_collab.ts for the
 * rig. Env-gated: skips cleanly when the two-instance rig isn't reachable.
 */
import { test, expect } from '@playwright/test';
import {
  ALICE_API, BOB_API, cleanup, mkComment, newRig, rigUnavailable,
  setupSharedConversation, waitText, type Rig,
} from './_doc_comment_collab';

test('binding criterion: a comment by either peer reaches the other [doc_comment_create_sync]', async () => {
  test.setTimeout(60_000);
  const rq = await newRig();
  const skip = await rigUnavailable(rq);
  test.skip(!!skip, skip ?? '');

  let rig: Rig | undefined;
  try {
    rig = await setupSharedConversation(rq);
    const { convId } = rig;

    // A→B: alice creates a comment → bob receives it.
    const a = await mkComment(rq, ALICE_API, convId, `alice-create-${convId.slice(0, 6)}`, 3);
    expect(await waitText(rq, BOB_API, convId, a, `alice-create-${convId.slice(0, 6)}`), 'create A→B: bob receives alice comment').toBeTruthy();

    // B→A: bob creates a comment → alice receives it.
    const b = await mkComment(rq, BOB_API, convId, `bob-create-${convId.slice(0, 6)}`, 4);
    expect(await waitText(rq, ALICE_API, convId, b, `bob-create-${convId.slice(0, 6)}`), 'create B→A: alice receives bob comment').toBeTruthy();
  } finally {
    if (rig) await cleanup(rq, rig.convId);
    await rq.dispose();
  }
});
