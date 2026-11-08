/**
 * IT messages on the desktop: the IT conversation's chip, a machine's reply as it reads, and the
 * `agent/<id>/it_message` body a draft becomes. Pure logic -- no backend.
 */
import { describe, expect, it } from 'vitest';
import { Conversation, ConversationKind } from '@sdk';
import type { ItReplyMeta } from '@sdk/entities/agent';
import { FlowMessage, itReplyOf } from '@sdk/entities/flow-message';
import { chipsFor, conversationFacets, type CategoryInputs } from '@src/components/conversation/conversation-category';
import { itMachineName, itReplyView, itValueChips } from '@src/components/conversation/it-reply';
import { itMessageRequest } from '@src/components/assets/editor/agent-profile/it-message';

function inputs(kind: ConversationKind): CategoryInputs {
  return {
    conv: { kind, archived_at: null } as unknown as Conversation,
    firstMessage: null,
    latestMessage: null,
    latestPtrTs: null,
    invitation: null,
    viewer: { email: 'teacher@x.test', cloudUserId: null },
  };
}

const reply = (over: Partial<ItReplyMeta>): ItReplyMeta => ({
  node_typeid: 'compute_node-1',
  code_last4: 'H8LC',
  state: 'done',
  ...over,
});

describe('IT conversation chip', () => {
  it('an IT conversation carries the IT chip', () => {
    const f = conversationFacets(inputs(ConversationKind.IT));
    expect(f.kind).toBe('it');
    expect(chipsFor(f).map((c) => c.key)).toEqual(['it']);
    expect(chipsFor(f)[0].label).toBe('IT');
  });

  it('a direct conversation has none', () => {
    expect(chipsFor(conversationFacets(inputs(ConversationKind.DIRECT)))).toEqual([]);
  });
});

describe('a machine reply', () => {
  it('done: fields as chips, open machine, no turn-on', () => {
    const r = reply({ value: { summary: 'Snake runs.', tasks: [{}, {}, {}] } });
    expect(itValueChips(r.value)).toEqual(['summary: Snake runs.', 'tasks: 3']);
    expect(itReplyView(r)).toMatchObject({ tone: 'ok', openMachine: true, turnOnAndRun: false });
    expect(itReplyView({ ...r, woke: true }).label).toMatch(/Woke the paused machine/);
    expect(itMachineName(r)).toBe('••••H8LC');
  });

  it('off offers Turn on and run; signed in offers nothing', () => {
    expect(itReplyView(reply({ state: 'off' }))).toMatchObject({ tone: 'warn', turnOnAndRun: true });
    expect(itReplyView(reply({ state: 'signed_in' }))).toMatchObject({ turnOnAndRun: false, openMachine: false });
    expect(itValueChips(null)).toEqual([]);
  });

  it('reads off the hub metadata or the local it_reply', () => {
    const it = reply({ state: 'off' });
    expect(itReplyOf({ it })).toEqual(it);
    expect(itReplyOf(null)).toBeNull();
    expect(new FlowMessage({ metadata: { it } }).it_reply).toEqual(it);
    expect(new FlowMessage({ it_reply: it }).it_reply).toEqual(it);
  });
});

describe('the it_message body', () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it('files ride as attachments; a *.shape.json becomes the answer shape', () => {
    const body = itMessageRequest('Check progress', [
      { name: 'class-status.md', bytes: enc('# skill') },
      { name: 'class-status.shape.json', bytes: enc('{"type":"object"}') },
    ]);
    expect(body).toEqual({
      text: 'Check progress',
      attachments: [{ name: 'class-status.md', content_b64: btoa('# skill') }],
      answer_shape: { type: 'object' },
      targets: 'all',
    });
  });

  it('a shape that is not an object is refused', () => {
    expect(() => itMessageRequest('x', [{ name: 'a.shape.json', bytes: enc('[1]') }])).toThrow(/JSON object/);
  });
});
