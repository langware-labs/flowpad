/**
 * Scenario: doc_comment_thread_sync
 * Source: ui/tests/manual_regression/collaboration/doc_comment_thread_sync.md
 * ScenarioId: 8cf45979-5767-4212-bc2c-45ddf3eb0fcc
 *
 * Two real instances through the local hub; see _doc_comment_collab.ts for the rig
 * (env-gated; skips when the two-instance rig isn't reachable).
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { ALICE_API, BOB_API, waitText, withSharedConversation } from './_doc_comment_collab';

async function post(rq: APIRequestContext, api: string, convId: string, text: string, data: object): Promise<string> {
  const r = await rq.post(`${api}/api/v1/graph/conversation/${convId}/comment`, { data: { raw_content: text, data } });
  const id = (await r.json())?.data?.id;
  if (!id) throw new Error(`comment create failed on ${api}: ${r.status()}`);
  return id;
}

const FORM = { form_id: 'launch', title: 'Launch decisions', fields: [{ id: 'date', label: 'Launch date', type: 'date' }] };

test('binding criterion: a doc comment thread crosses peers whole [doc_comment_thread_sync]', withSharedConversation(async (rq, { convId }) => {
  const tag = convId.slice(0, 6);

  // A→B: alice asks.
  const root = await post(rq, ALICE_API, convId, `ask-${tag}`, { kind: 'questions', status: 'open', anchor: { quote: 'Line 2' }, form: FORM });
  const got = (await waitText(rq, BOB_API, convId, root, `ask-${tag}`)) as { data?: { form?: { title?: string } } } | null;
  expect(got?.data?.form?.title, 'A→B: bob receives the questions with their form').toBe('Launch decisions');

  // B→A: bob answers (a reply carrying answers + status) and replies.
  const answers = { form_id: 'launch', values: { date: '2026-12-01' } };
  const ans = await post(rq, BOB_API, convId, `answer-${tag}`, { reply: true, reply_to: `comment-${root}`, answers, status: 'sent' });
  const rep = await post(rq, BOB_API, convId, `reply-${tag}`, { reply: true, reply_to: `comment-${root}` });

  const a = (await waitText(rq, ALICE_API, convId, ans, `answer-${tag}`)) as { data?: Record<string, unknown> } | null;
  expect(a?.data, 'B→A: alice receives bob\'s answers').toMatchObject({ reply_to: `comment-${root}`, answers, status: 'sent' });
  expect(await waitText(rq, ALICE_API, convId, rep, `reply-${tag}`), 'B→A: alice receives bob\'s reply').toBeTruthy();
}));
