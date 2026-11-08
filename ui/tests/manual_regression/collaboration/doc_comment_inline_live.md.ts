/**
 * Scenario: doc_comment_inline_live
 * Source: ui/tests/manual_regression/collaboration/doc_comment_inline_live.md
 * ScenarioId: ad74a288-2b09-485f-8922-bc4d8aaf5b3f
 *
 * Page-level: Bob's real UI. Env-gated on top of the two-instance rig
 * (_doc_comment_collab.ts): QA_BOB_UI, QA_BOB_PROJECT_ID, QA_BOB_PROJECT_DIR.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { request as pwRequest, test, expect } from '@playwright/test';
import { ALICE_API, BOB_API, rigUnavailable, setupSharedConversation, waitText } from './_doc_comment_collab';

const BOB_UI = process.env.QA_BOB_UI;
const BOB_PROJECT_ID = process.env.QA_BOB_PROJECT_ID;
const BOB_PROJECT_DIR = process.env.QA_BOB_PROJECT_DIR;
const FORM = { form_id: 'launch', title: 'Launch decisions', fields: [{ id: 'date', label: 'Launch date', type: 'date' }] };

test('binding criterion: a doc comment is drawn in the doc and replies arrive live [doc_comment_inline_live]', async ({ page }) => {
  test.setTimeout(90_000);
  test.skip(!BOB_UI || !BOB_PROJECT_ID || !BOB_PROJECT_DIR, 'needs QA_BOB_UI, QA_BOB_PROJECT_ID, QA_BOB_PROJECT_DIR');
  const rq = await pwRequest.newContext();
  const skip = await rigUnavailable(rq);
  test.skip(!!skip, skip ?? '');
  const mdId = randomUUID();
  const dir = `${BOB_PROJECT_DIR}/docs`;
  const path = `${dir}/e2etest-inline-${mdId.slice(0, 6)}.md`;
  let convId: string | undefined;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, `---\nid: ${mdId}\n---\n\n# Shared doc\n\nLine 2\n`);
    const md = await rq.post(`${ALICE_API}/api/v1/graph/markdown`, { data: { id: mdId, title: 'Shared doc', asset_ref: path } });
    expect(md.ok(), 'alice creates the doc').toBeTruthy();
    convId = (await setupSharedConversation(rq, [`markdown-${mdId}`])).convId;
    await rq.post(`${BOB_API}/api/v1/graph/compute_node/@local/fs-records/index`, { params: { type: 'markdown', path } });

    const comment = async (text: string, data: object) =>
      (await (await rq.post(`${ALICE_API}/api/v1/graph/markdown/${mdId}/comment`, { data: { raw_content: text, data } })).json()).data.id as string;
    const root = await comment('Two decisions before I finish.', { kind: 'questions', status: 'open', author: 'agent', anchor: { quote: 'Line 2' }, form: FORM });
    expect(await waitText(rq, BOB_API, convId, root, 'Two decisions before I finish.'), 'bob receives the questions').toBeTruthy();

    // Bob's page: the card is drawn in the doc, after the passage it quotes.
    await page.goto(`${BOB_UI}/dock/project/${BOB_PROJECT_ID}/editor/markdown/typeid/markdown-${mdId}`);
    const card = page.locator(`[data-testid="doc-comment-card"][data-comment-id="comment-${root}"]`);
    await expect(card).toContainText('Launch decisions', { timeout: 30_000 });
    await expect(page.locator(`.flowpad-comment-mark[data-comment-id="comment-${root}"]`)).toHaveText('Line 2');

    // Alice replies while Bob's page stays open: it shows up without a reload.
    await comment('Alice: launch set to Dec 1.', { reply: true, reply_to: `comment-${root}`, author: 'agent', status: 'done' });
    await expect(card).toContainText('Alice: launch set to Dec 1.', { timeout: 20_000 });
    await expect(card.locator('[data-testid="comment-status"]')).toHaveText('Done');
  } finally {
    if (convId) for (const api of [ALICE_API, BOB_API]) await rq.delete(`${api}/api/v1/graph/conversation/${convId}`).catch(() => undefined);
    rmSync(path, { force: true });
    await rq.dispose();
  }
});
