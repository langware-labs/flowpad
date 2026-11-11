import { Conversation, conversationRowMessageIds, FlowMessage } from '@sdk';
import { describe, expect, it } from 'vitest';

const C1 = '0b8f3c1e-1111-4a6b-9c1d-000000000001';
const C2 = '0b8f3c1e-1111-4a6b-9c1d-000000000002';
const C3 = '0b8f3c1e-1111-4a6b-9c1d-000000000003';

// A hub row keeps no `message_ids` log; it names its newest message instead, so the stream inbox
// batches every row's preview into one read rather than one query per row.
describe('a conversation row without a pointer log', () => {
  it('points at its newest message, and keeps no log', () => {
    const conv = new Conversation({ id: C1, latest_message_id: 'm9', latest_message_at: '2026-10-23T10:00:00Z' });
    expect(conv.latestMessagePointer).toEqual({ type: FlowMessage.type, id: 'm9', ts: '2026-10-23T10:00:00Z' });
    // The log stays the log: a conversation view must not read one message as the whole thread.
    expect(conv.conversationMessageIds).toEqual([]);
  });

  it('has no pointer when it has no message', () => {
    expect(new Conversation({ id: C2 }).latestMessagePointer).toBeNull();
  });

  it('joins the one batch the list reads', () => {
    const hub = new Conversation({ id: C1, latest_message_id: 'm9', latest_message_at: '2026-10-23T10:00:00Z' });
    const empty = new Conversation({ id: C2 });
    expect(conversationRowMessageIds([hub, empty])).toEqual(['m9']);
  });

  it('a row with a pointer log reads only the log', () => {
    const conv = new Conversation({
      id: C3,
      latest_message_id: 'hub-only',
      message_ids: JSON.stringify([
        { typeid: 'flow_message-m1', ts: '2026-10-23T09:00:00Z' },
        { typeid: 'flow_message-m2', ts: '2026-10-23T11:00:00Z' },
      ]),
    });
    expect(conv.conversationMessageIds.map((p) => p.id)).toEqual(['m1', 'm2']);
    expect(conv.latestMessagePointer?.id).toBe('m2');
    expect(conversationRowMessageIds([conv])).toEqual(['m1', 'm2']);
  });
});
