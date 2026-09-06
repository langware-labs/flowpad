/**
 * anchorSessionItems — every live session is pinned to the message that
 * opened it; everything else of the session (follow-up prompts, replies,
 * lifecycle lines) is hidden from the thread and counted on the card.
 */
import { FlowMessage, FlowMessageKind } from '@sdk';
import { describe, expect, it } from 'vitest';

import {
  anchorSessionItems,
  buildConversationItems,
  ConversationItemKind,
  type SessionAnchorItem,
} from '@src/components/conversation/conversation-items';

const SID_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const SID_B = 'bbbbbbbb-0000-4000-8000-000000000002';

let seq = 0;
function fm(over: Partial<FlowMessage> = {}): FlowMessage {
  seq += 1;
  return new FlowMessage({ id: `msg-${seq}`, text: `m${seq}`, ...over } as Partial<FlowMessage>);
}

function pointerItems(messages: FlowMessage[]) {
  const pointers = messages.map((m, i) => ({ id: m.id, ts: new Date(2026, 0, 1, 0, i).toISOString() }));
  const byId = new Map(messages.map((m) => [m.id, m]));
  const items = buildConversationItems(pointers, []);
  return { items, getFm: (id: string) => byId.get(id) ?? null };
}

const promptAtt = { attachment_type: 'prompt', data: 'run it' };
const resultAtt = { attachment_type: 'type_id', data: 'prompt_completion-r1' };
const sess = (sid: string, over: Partial<FlowMessage> = {}) => fm({ remote_worker_session_id: sid, ...over } as Partial<FlowMessage>);

describe('anchorSessionItems', () => {
  it('anchors a session on its starting message and hides follow-ups, replies and session events', () => {
    const start = sess(SID_A, { attachment: [promptAtt] } as Partial<FlowMessage>);
    const messages = [
      fm(),
      start,
      sess(SID_A, { attachment: [resultAtt] } as Partial<FlowMessage>),
      sess(SID_A, { attachment: [promptAtt] } as Partial<FlowMessage>),
      sess(SID_A, { kind: FlowMessageKind.SESSION_EVENT, attachment: [{ attachment_type: 'type_id', data: `remote_worker_session-${SID_A}` }] } as Partial<FlowMessage>),
      fm(),
    ];
    const { items, getFm } = pointerItems(messages);
    const out = anchorSessionItems(items, getFm, new Map([[SID_A, start.id]]));
    expect(out.map((g) => g.kind)).toEqual([
      ConversationItemKind.POINTER,
      ConversationItemKind.SESSION_ANCHOR,
      ConversationItemKind.POINTER,
    ]);
    const card = out[1] as SessionAnchorItem;
    expect(card.sessionId).toBe(SID_A);
    expect(card.anchor.kind === ConversationItemKind.POINTER && card.anchor.messageId).toBe(start.id);
    expect(card.promptCount).toBe(2);
    expect(card.replyCount).toBe(1);
    expect(card.sortAt).toBe(items[1].sortAt);
  });

  it('falls back to the earliest prompt-bearing message when the session row is unknown', () => {
    const messages = [
      sess(SID_A, { attachment: [resultAtt] } as Partial<FlowMessage>), // a stray reply first
      sess(SID_A, { attachment: [promptAtt] } as Partial<FlowMessage>),
      sess(SID_A, { attachment: [promptAtt] } as Partial<FlowMessage>),
    ];
    const { items, getFm } = pointerItems(messages);
    const out = anchorSessionItems(items, getFm); // no index at all
    expect(out).toHaveLength(1);
    const card = out[0] as SessionAnchorItem;
    expect(card.anchor.kind === ConversationItemKind.POINTER && card.anchor.messageId).toBe(messages[1].id);
    expect(card.promptCount).toBe(2);
    expect(card.replyCount).toBe(1);
    // a row that exists but has not synced its starting id behaves the same
    const out2 = anchorSessionItems(items, getFm, new Map([[SID_A, null]]));
    expect(out2).toHaveLength(1);
  });

  it('keeps one anchor per session across interleaved human chatter', () => {
    const start = sess(SID_A, { attachment: [promptAtt] } as Partial<FlowMessage>);
    const messages = [start, fm(), sess(SID_A, { attachment: [promptAtt] } as Partial<FlowMessage>), fm()];
    const { items, getFm } = pointerItems(messages);
    const out = anchorSessionItems(items, getFm, new Map([[SID_A, start.id]]));
    expect(out.map((g) => g.kind)).toEqual([
      ConversationItemKind.SESSION_ANCHOR,
      ConversationItemKind.POINTER,
      ConversationItemKind.POINTER,
    ]);
    expect((out[0] as SessionAnchorItem).promptCount).toBe(2);
  });

  it('emits two anchors for two sessions in timeline order', () => {
    const a = sess(SID_A, { attachment: [promptAtt] } as Partial<FlowMessage>);
    const b = sess(SID_B, { attachment: [promptAtt] } as Partial<FlowMessage>);
    const messages = [a, sess(SID_A, { attachment: [resultAtt] } as Partial<FlowMessage>), b, sess(SID_B, { attachment: [resultAtt] } as Partial<FlowMessage>)];
    const { items, getFm } = pointerItems(messages);
    const out = anchorSessionItems(items, getFm, new Map([[SID_A, a.id], [SID_B, b.id]]));
    expect(out.map((g) => (g as SessionAnchorItem).sessionId)).toEqual([SID_A, SID_B]);
    expect(out.map((g) => (g as SessionAnchorItem).replyCount)).toEqual([1, 1]);
  });

  it('leaves unresolved bodies and session-less messages flat', () => {
    const messages = [sess(SID_A), fm()];
    const { items } = pointerItems(messages);
    const out = anchorSessionItems(items, () => null, new Map([[SID_A, messages[0].id]]));
    expect(out.map((g) => g.kind)).toEqual([ConversationItemKind.POINTER, ConversationItemKind.POINTER]);
  });

  it('hides a host draft reply that belongs to a session', () => {
    const start = sess(SID_A, { attachment: [promptAtt] } as Partial<FlowMessage>);
    const draft = sess(SID_A, { is_draft: true, attachment: [resultAtt] } as Partial<FlowMessage>);
    const { items: pointerOnly, getFm } = pointerItems([start]);
    const items = [...pointerOnly, ...buildConversationItems([], [draft])];
    const out = anchorSessionItems(items, getFm, new Map([[SID_A, start.id]]));
    expect(out).toHaveLength(1);
    expect((out[0] as SessionAnchorItem).replyCount).toBe(1);
  });

  it('a session with no prompt in the window contributes no row', () => {
    const messages = [sess(SID_A, { attachment: [resultAtt] } as Partial<FlowMessage>)];
    const { items, getFm } = pointerItems(messages);
    expect(anchorSessionItems(items, getFm)).toEqual([]);
  });
});
