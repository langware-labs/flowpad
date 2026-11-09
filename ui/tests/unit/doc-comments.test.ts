import { describe, expect, it } from 'vitest';
import { Schema } from '@milkdown/prose/model';
import { Comment } from '@sdk';
import { buildThreads, type DocThread } from '@src/hooks/use-doc-comment-threads';
import { resolveQuote } from '@src/components/milkdown-editor/plugins/comment-widgets';
import { buildCommentsPrompt, isReady } from '@src/components/assets/editor/doc-comments/send';

const DOC = 'markdown-ccba1273-d718-434d-bca1-74e4be6c662a';
const ROOT = '4e244a55-2ce7-4e50-bdb8-662d395f169c';
const OTHER_DOC = 'markdown-fbb750b5-c487-4703-af9a-ce6d02cb93dd';

const comment = (id: string, parent: string, data: Record<string, unknown>, text = '', at = '2026-11-08T10:00:00Z') =>
  new Comment({ id, parent_type_id: parent, raw_content: text, data, created_date: at } as never);

const FORM = {
  form_id: 'q',
  title: 'Launch decisions',
  fields: [
    { id: 'date', label: 'Launch date', type: 'date' as const },
    { id: 'ch', label: 'Channels', type: 'many' as const, options: ['Email', 'Slack'] },
  ],
};

describe('buildThreads', () => {
  it('groups a doc’s replies under their root, oldest first, and ignores other docs and line comments', () => {
    const threads = buildThreads(
      [
        comment(ROOT, DOC, { kind: 'questions', anchor: { quote: 'first week' }, form: FORM, author: 'agent' }),
        comment('a1b2c3d4-0000-4000-8000-000000000002', DOC, { reply: true, reply_to: `comment-${ROOT}`, author: 'agent' }, 'second', '2026-11-08T10:02:00Z'),
        comment('a1b2c3d4-0000-4000-8000-000000000001', DOC, { reply: true, reply_to: `comment-${ROOT}`, author: 'me' }, 'first', '2026-11-08T10:01:00Z'),
        comment('a1b2c3d4-0000-4000-8000-000000000003', OTHER_DOC, { kind: 'text', anchor: { quote: 'x' } }),
        comment('a1b2c3d4-0000-4000-8000-000000000004', DOC, { line: 3 }, 'gutter note'),
      ],
      DOC,
    );
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ id: `comment-${ROOT}`, kind: 'questions', status: 'open', quote: 'first week' });
    expect(threads[0].replies.map((r) => r.text)).toEqual(['first', 'second']);
  });

  it('takes status and answers from the latest reply that carries them, without showing bare ones', () => {
    const r = (n: number, data: Record<string, unknown>, text = '') =>
      comment(`a1b2c3d4-0000-4000-8000-00000000001${n}`, DOC, { reply: true, reply_to: `comment-${ROOT}`, ...data }, text, `2026-11-08T10:0${n}:00Z`);
    const [t] = buildThreads(
      [
        comment(ROOT, DOC, { kind: 'questions', anchor: { quote: 'w' }, form: FORM }),
        r(1, { answers: { form_id: 'q', values: { date: '2026-12-01' } }, status: 'sent' }),
        r(2, { status: 'done' }, 'Set the launch to Dec 1.'),
      ],
      DOC,
    );
    expect(t.status).toBe('done');
    expect(t.answers).toEqual({ date: '2026-12-01' });
    expect(t.replies.map((x) => x.text)).toEqual(['Set the launch to Dec 1.']);
  });

  it('moves a thread to the text a re-anchor reply names', () => {
    const [t] = buildThreads(
      [
        comment(ROOT, DOC, { kind: 'change_request', anchor: { quote: 'old text' }, change: { instruction: 'x' } }),
        comment('a1b2c3d4-0000-4000-8000-000000000021', DOC, { reply: true, reply_to: `comment-${ROOT}`, anchor: { quote: 'new text' } }, '', '2026-11-08T10:05:00Z'),
      ],
      DOC,
    );
    expect(t.quote).toBe('new text');
    expect(t.replies).toEqual([]);
  });
});

describe('resolveQuote — where a comment sits after the doc moves', () => {
  const schema = new Schema({
    nodes: { doc: { content: 'block+' }, paragraph: { group: 'block', content: 'inline*' }, text: { group: 'inline' } },
  });
  const docOf = (...paras: string[]) => schema.node('doc', null, paras.map((p) => schema.node('paragraph', null, [schema.text(p)])));

  it('finds the exact quote', () => {
    const doc = docOf('Intro.', 'Pricing starts at $49/month per workspace.');
    expect(resolveQuote(doc, 'Pricing starts at $49/month per workspace.')).toEqual({ from: 9, to: 51 });
  });

  it('follows a rewritten passage by its opening words', () => {
    const doc = docOf('Intro.', 'Pricing starts at $39/month for the first year.');
    const at = resolveQuote(doc, 'Pricing starts at $49/month per workspace.');
    expect(at && doc.textBetween(at.from, at.to)).toBe('Pricing starts at');
  });

  it('is gone when even the opening words are', () => {
    expect(resolveQuote(docOf('Something else entirely.'), 'Pricing starts at $49/month.')).toBeNull();
  });
});

describe('Send', () => {
  const thread = (over: Partial<DocThread>): DocThread => ({
    id: `comment-${ROOT}`,
    kind: 'text',
    status: 'open',
    author: null,
    quote: 'q',
    text: '',
    form: null,
    answers: null,
    instruction: null,
    replies: [],
    createdAt: '',
    ...over,
  });

  it('sends answered questions and change requests, never plain notes or sent ones', () => {
    expect(isReady(thread({ kind: 'questions', form: FORM, answers: { date: '2026-12-01' } }))).toBe(true);
    expect(isReady(thread({ kind: 'questions', form: FORM, answers: null }))).toBe(false);
    expect(isReady(thread({ kind: 'change_request', instruction: 'shorter' }))).toBe(true);
    expect(isReady(thread({ kind: 'change_request', instruction: 'shorter', status: 'sent' }))).toBe(false);
    expect(isReady(thread({ kind: 'text' }))).toBe(false);
  });

  it('asks the agent to act on the answers and report in each thread', () => {
    const prompt = buildCommentsPrompt(DOC, 'plan', 'plan.md', [
      thread({ kind: 'questions', form: FORM, answers: { date: '2026-12-01', ch: ['Email', 'Slack'] }, quote: 'first week' }),
      thread({ id: 'comment-c2', kind: 'change_request', instruction: 'Make it $39', quote: 'Pricing starts at $49' }),
    ]);
    expect(prompt).toContain('Act on the answers');
    expect(prompt).toContain('- Launch date: 2026-12-01');
    expect(prompt).toContain('- Channels: Email, Slack');
    expect(prompt).toContain('Change: Make it $39 (comment-c2)');
    expect(prompt).toContain(`comment-${ROOT}, comment-c2`);
    expect(prompt).toContain("flow record comment reply COMMENT_ID 'ONE LINE'");
  });
});
