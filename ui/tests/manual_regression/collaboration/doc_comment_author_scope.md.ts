/**
 * Scenario: doc_comment_author_scope
 *
 * The half of author-scoped editing that must never regress: a peer must NOT be
 * able to edit someone else's comment. `policies.json` keeps comment
 * update/delete at EDITOR level precisely because the rule once sat on reader,
 * which let any reader of a shared parent edit and DELETE other people's
 * comments. Author scope is expressed by a direct editor edge minted for the
 * creator on the comment it just created; this asserts that edge is scoped to
 * the author and grants nothing wider.
 *
 * The positive half (a peer edits its OWN comment and it syncs) is
 * doc_comment_update_sync — deliberately not repeated here, so this stays inside
 * one convergence budget.
 */
import { test, expect } from '@playwright/test';
import { ALICE_API, BOB_API, mkComment, waitText, withSharedConversation } from './_doc_comment_collab';

test("binding criterion: a peer cannot edit another's comment [doc_comment_author_scope]", withSharedConversation(async (rq, { convId }) => {
  const aliceOwned = await mkComment(rq, ALICE_API, convId, 'alice-owned', 7);
  expect(await waitText(rq, BOB_API, convId, aliceOwned, 'alice-owned'), 'setup: bob sees alice comment').toBeTruthy();

  // Bob holds `member` on the conversation and no author edge on THIS comment.
  await rq
    .put(`${BOB_API}/api/v1/graph/comment/${aliceOwned}`, {
      data: { raw_content: 'bob-tampered' },
      headers: { 'Hub-Reflect': 'true' },
    })
    .catch(() => undefined);

  // Decisive on alice's side: whatever bob's instance did locally, the hub must
  // not have accepted it, so alice's text is untouched.
  expect(
    await waitText(rq, ALICE_API, convId, aliceOwned, 'alice-owned'),
    "a peer must not be able to edit another's comment",
  ).toBeTruthy();
}));
