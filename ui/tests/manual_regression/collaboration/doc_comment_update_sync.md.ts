/**
 * Scenario: doc_comment_update_sync
 * Source: ui/tests/manual_regression/collaboration/doc_comment_update_sync.md
 * ScenarioId: a43f4285-07ed-4f06-b299-071da5081e5e
 *
 * Browser/Playwright tier — editing a shared comment child reflects the new text
 * to the peer, both directions. See _doc_comment_collab.ts for the rig.
 */
import { test, expect } from '@playwright/test';
import { ALICE_API, BOB_API, editComment, mkComment, waitText, withSharedConversation } from './_doc_comment_collab';

test('binding criterion: editing a comment syncs the new text [doc_comment_update_sync]', withSharedConversation(async (rq, { convId }) => {
  // A→B: alice creates u1 → bob sees u1 → alice edits → bob sees the edit.
  const a = await mkComment(rq, ALICE_API, convId, 'u1', 3);
  expect(await waitText(rq, BOB_API, convId, a, 'u1'), 'update setup: bob sees u1').toBeTruthy();
  await editComment(rq, ALICE_API, a, 'edited-by-alice');
  expect(await waitText(rq, BOB_API, convId, a, 'edited-by-alice'), 'update A→B: edit reaches bob').toBeTruthy();

  // B→A: bob creates u1 → alice sees u1 → bob edits → alice sees the edit.
  const b = await mkComment(rq, BOB_API, convId, 'u1', 4);
  expect(await waitText(rq, ALICE_API, convId, b, 'u1'), 'update setup: alice sees u1').toBeTruthy();
  await editComment(rq, BOB_API, b, 'edited-by-bob');
  expect(await waitText(rq, ALICE_API, convId, b, 'edited-by-bob'), 'update B→A: edit reaches alice').toBeTruthy();
}));
