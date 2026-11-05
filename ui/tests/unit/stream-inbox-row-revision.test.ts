import { describe, expect, it } from 'vitest';
import type { AgenticProcess, Conversation } from '@sdk';
import { rowRevision } from '@src/components/stream-inbox-view/StreamInboxView';

// The store updates an entity IN PLACE, so a memoized row can only tell its conversation changed by
// its revision — any field, stored or projected, and its automation mark's state.
describe('stream inbox row revision', () => {
  const conv = () => ({ id: 'c1', title: 'Hello', is_unread: false, unread_count: 0, message_ids: '[]' }) as unknown as Conversation;

  it('is stable while nothing changed and moves with any field changed in place', () => {
    const c = conv();
    const before = rowRevision(c);
    expect(rowRevision(c)).toBe(before);
    (c as unknown as { is_unread: boolean }).is_unread = true;
    expect(rowRevision(c)).not.toBe(before);
    const after = rowRevision(c);
    (c as unknown as { message_ids: string }).message_ids = '[{"typeid":"flow_message-1"}]';
    expect(rowRevision(c)).not.toBe(after);
  });

  it("moves with the automation mark's status", () => {
    const c = conv();
    const mark = { id: 'p1', status: 'running' } as unknown as AgenticProcess;
    const running = rowRevision(c, mark);
    (mark as unknown as { status: string }).status = 'done';
    expect(rowRevision(c, mark)).not.toBe(running);
  });

  it('a field that cannot be written out reads as changed, never as the same', () => {
    const c = conv() as unknown as Record<string, unknown>;
    c.self = c;
    expect(rowRevision(c as unknown as Conversation)).not.toBe(rowRevision(c as unknown as Conversation));
  });
});
