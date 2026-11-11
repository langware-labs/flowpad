/**
 * IT messages on the desktop: the IT conversation's chip, a machine's reply as it reads, and the
 * `agent/<id>/it_message` body a draft becomes. Pure logic -- no backend.
 */
import { describe, expect, it } from 'vitest';
import { Conversation, ConversationKind } from '@sdk';
import type { ItReplyMeta } from '@sdk/entities/agent';
import { FlowMessage, itReplyOf, itRequestOf } from '@sdk/entities/flow-message';
import { chipsFor, conversationFacets, type CategoryInputs } from '@src/components/conversation/conversation-category';
import { itMachineName, itReplyView, itValueChips } from '@src/components/conversation/it-reply';
import { itMessageRequest, opIdOf } from '@src/components/assets/editor/agent-profile/it-message';
import { indexItSends, itOperationOf } from '@src/components/conversation/it-sends';

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

  it('a failed session reads as failed, never done', () => {
    expect(itReplyView(reply({ state: 'failed' }))).toMatchObject({
      label: 'IT session failed',
      tone: 'bad',
      turnOnAndRun: false,
      openMachine: true,
    });
  });

  it('IT Disabled offers Enable and run; signed in offers nothing', () => {
    expect(itReplyView(reply({ state: 'off' }))).toMatchObject({
      label: 'IT is disabled on this machine',
      tone: 'warn',
      turnOnAndRun: true,
    });
    expect(itReplyView(reply({ state: 'signed_in' }))).toMatchObject({ turnOnAndRun: false, openMachine: false });
    expect(itValueChips(null)).toEqual([]);
  });

  it('reads off the hub metadata or the local it_reply', () => {
    const it = reply({ state: 'off' });
    expect(itReplyOf({ it })).toEqual(it);
    expect(itReplyOf(null)).toBeNull();
    // The owner's IT message carries metadata.it (its attachment names) but names no machine: not a reply.
    expect(itReplyOf({ it: { attachments: ['shape.json'] } })).toBeNull();
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

const AGENT = 'agent-1';
const ID: Record<string, string> = {
  r1: '00000000-0000-4000-8000-000000000001',
  r2: '00000000-0000-4000-8000-000000000002',
  a1: '00000000-0000-4000-8000-000000000003',
  a2: '00000000-0000-4000-8000-000000000004',
  a3: '00000000-0000-4000-8000-000000000005',
  b1: '00000000-0000-4000-8000-000000000006',
  a1b: '00000000-0000-4000-8000-000000000007',
  old: '00000000-0000-4000-8000-000000000008',
  orphan: '00000000-0000-4000-8000-000000000009',
  f1: '00000000-0000-4000-8000-000000000010',
};
const ids = (xs: string[]) => xs.map((x) => ID[x]);
const request = (id: string, sendId: string, at: string) =>
  new FlowMessage({
    id: ID[id],
    sender_id: 'owner-1',
    created_date: at,
    metadata: { it: { attachments: [], agent_id: AGENT, op_id: 'class-status', send_id: sendId } },
  } as never);
const answer = (id: string, node: string, sendId: string | undefined, at: string, over: Partial<ItReplyMeta> = {}) =>
  new FlowMessage({
    id: ID[id],
    text: `answer ${id}`,
    sender_id: AGENT,
    created_date: at,
    metadata: { it: { ...reply({ node_typeid: node, ...over }), ...(sendId ? { send_id: sendId } : {}) } },
  } as never);

describe('an operation id', () => {
  it('is the name as the hub slugs it', () => {
    expect(opIdOf('Class status')).toBe('class-status');
    expect(opIdOf('  Hall of Fame: update #2 ')).toBe('hall-of-fame-update-2');
    expect(opIdOf('!!!')).toBe('');
    expect(opIdOf('x'.repeat(200))).toHaveLength(64);
  });

  it('the owner request names its send, a reply does not', () => {
    const it = { attachments: [], agent_id: AGENT, op_id: 'class-status', send_id: 's1' };
    expect(itRequestOf({ it })).toEqual({ agent_id: AGENT, op_id: 'class-status', send_id: 's1' });
    expect(itRequestOf({ it: { attachments: [] } })).toBeNull(); // a request from before operations
    expect(itRequestOf({ it: { node_typeid: 'compute_node-1', send_id: 's1' } })).toBeNull();
    expect(new FlowMessage({ metadata: { it } }).it_request?.send_id).toBe('s1');
  });
});

describe('a send of an operation, drawn as a table', () => {
  it('groups each answer under the request of its send', () => {
    const fms = [
      request('r1', 's1', '2026-11-10T10:00:00Z'),
      answer('a1', 'compute_node-1', 's1', '2026-11-10T10:01:00Z', { state: 'off' }),
      answer('a2', 'compute_node-2', 's1', '2026-11-10T10:01:05Z'),
      request('r2', 's2', '2026-11-10T11:00:00Z'),
      answer('b1', 'compute_node-1', 's2', '2026-11-10T11:01:00Z'),
      // A late answer of the FIRST send still lands under the first request.
      answer('a3', 'compute_node-3', 's1', '2026-11-10T11:02:00Z'),
    ];
    const { sendByMessage, replyMessageIds } = indexItSends(fms);
    expect(sendByMessage.get(ID.r1)?.rows.map((r) => r.messageId)).toEqual(ids(['a1', 'a2', 'a3']));
    expect(sendByMessage.get(ID.r2)?.rows.map((r) => r.messageId)).toEqual(ids(['b1']));
    expect([...replyMessageIds].sort()).toEqual(ids(['a1', 'a2', 'a3', 'b1']).sort());
    expect(itOperationOf(fms, sendByMessage)).toEqual({ opId: 'class-status', agentId: AGENT, machines: 1 });
  });

  it('a machine asked again in one send shows its latest answer, in its first place', () => {
    const fms = [
      request('r1', 's1', '2026-11-10T10:00:00Z'),
      answer('a1', 'compute_node-1', 's1', '2026-11-10T10:01:00Z', { state: 'off' }),
      answer('a2', 'compute_node-2', 's1', '2026-11-10T10:01:05Z'),
      answer('a1b', 'compute_node-1', 's1', '2026-11-10T10:05:00Z', { state: 'done' }),
    ];
    const { sendByMessage, replyMessageIds } = indexItSends(fms);
    const rows = sendByMessage.get(ID.r1)?.rows ?? [];
    expect(rows.map((r) => [r.messageId, r.reply.state])).toEqual([
      [ID.a1b, 'done'],
      [ID.a2, 'done'],
    ]);
    // The superseded answer is still hidden from the feed: it is the same machine's line.
    expect(replyMessageIds.has(ID.a1)).toBe(true);
  });

  it('an answer with no send, or whose request is not here, stays a bubble', () => {
    const fms = [
      answer('old', 'compute_node-1', undefined, '2026-11-08T10:00:00Z'),
      answer('orphan', 'compute_node-2', 's-missing', '2026-11-10T10:00:00Z'),
    ];
    const { sendByMessage, replyMessageIds } = indexItSends(fms);
    expect(sendByMessage.size).toBe(0);
    expect(replyMessageIds.size).toBe(0);
    expect(itOperationOf(fms, sendByMessage)).toBeNull();
  });

  it("a message posing as a machine's answer but not written by the agent stays a bubble", () => {
    const forged = new FlowMessage({
      id: ID.f1,
      sender_id: 'owner-1',
      created_date: '2026-11-10T10:02:00Z',
      metadata: { it: { ...reply({}), send_id: 's1' } },
    } as never);
    const { sendByMessage, replyMessageIds } = indexItSends([request('r1', 's1', '2026-11-10T10:00:00Z'), forged]);
    expect(sendByMessage.size).toBe(0);
    expect(replyMessageIds.has(ID.f1)).toBe(false);
  });
});
