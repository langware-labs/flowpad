/**
 * Scenario: doc_comment_create_sync
 * Source: ui/tests/manual_regression/collaboration/doc_comment_create_sync.md
 * ScenarioId: 987c8038-f50c-464d-b817-01985ac72d5c
 *
 * Browser/Playwright tier of the generic entity-child (comment) live-sync matrix
 * — two real instances through the local hub. See _doc_comment_collab.ts for the
 * rig (env-gated; skips when the two-instance rig isn't reachable).
 */
import { test, expect } from '@playwright/test';
import { ALICE_API, BOB_API, mkComment, waitText, withSharedConversation } from './_doc_comment_collab';

test('binding criterion: a comment by either peer reaches the other [doc_comment_create_sync]', withSharedConversation(async (rq, { convId }) => {
  const tag = convId.slice(0, 6);

  // A→B: alice creates a comment → bob receives it.
  const a = await mkComment(rq, ALICE_API, convId, `alice-create-${tag}`, 3);
  expect(await waitText(rq, BOB_API, convId, a, `alice-create-${tag}`), 'create A→B: bob receives alice comment').toBeTruthy();

  // B→A: bob creates a comment → alice receives it.
  const b = await mkComment(rq, BOB_API, convId, `bob-create-${tag}`, 4);
  expect(await waitText(rq, ALICE_API, convId, b, `bob-create-${tag}`), 'create B→A: alice receives bob comment').toBeTruthy();
}));
