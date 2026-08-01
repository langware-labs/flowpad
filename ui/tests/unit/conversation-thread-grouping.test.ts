/**
 * Thread packing — one row per thread, and everything else left alone.
 *
 * The contract that matters: a conversation with no threaded messages must
 * render EXACTLY as it did before threading existed. Every Flowpad-native
 * message has `thread_id === null`, so "unchanged" is the common case and the
 * one worth pinning hardest.
 */
import { describe, expect, it } from 'vitest';
import type { FlowMessage } from '@sdk';
import {
  ConversationItemKind,
  buildConversationItems,
  groupThreadItems,
  type ThreadGroupItem,
} from '@src/components/conversation/conversation-items';

const at = (min: number) => new Date(Date.UTC(2026, 6, 31, 12, min)).toISOString();
const ptr = (id: string, min: number) => ({ id, type: 'flow_message', ts: at(min) });

/** A message table keyed by id; anything absent resolves to null (past the window). */
function table(rows: Record<string, string | null>) {
  return (id: string): FlowMessage | null =>
    id in rows ? ({ id, thread_id: rows[id] } as unknown as FlowMessage) : null;
}

describe('groupThreadItems', () => {
  it('leaves an all-internal conversation exactly as it was', () => {
    const items = buildConversationItems([ptr('a', 0), ptr('b', 1), ptr('c', 2)], []);
    const out = groupThreadItems(items, table({ a: null, b: null, c: null }));
    expect(out).toEqual(items);
  });

  it('packs one thread into a single row', () => {
    const items = buildConversationItems([ptr('a', 0), ptr('b', 1), ptr('c', 2)], []);
    const out = groupThreadItems(items, table({ a: 't1', b: 't1', c: 't1' }));
    expect(out).toHaveLength(1);
    const g = out[0] as ThreadGroupItem;
    expect(g.kind).toBe(ConversationItemKind.THREAD_GROUP);
    expect(g.threadId).toBe('t1');
    expect(g.children).toHaveLength(3);
  });

  it('renders the NEWEST message as the head', () => {
    const items = buildConversationItems([ptr('old', 0), ptr('new', 9)], []);
    const g = groupThreadItems(items, table({ old: 't1', new: 't1' }))[0] as ThreadGroupItem;
    expect(g.head.key).toBe('new');
  });

  it('re-partitions interleaved threads instead of breaking runs', () => {
    // Two merged threads whose messages alternate in time. The session grouper
    // would emit four fragments; a thread must be ONE row.
    const items = buildConversationItems(
      [ptr('a1', 0), ptr('b1', 1), ptr('a2', 2), ptr('b2', 3)],
      [],
    );
    const out = groupThreadItems(items, table({ a1: 'A', a2: 'A', b1: 'B', b2: 'B' }));
    expect(out).toHaveLength(2);
    expect((out as ThreadGroupItem[]).map((g) => g.threadId).sort()).toEqual(['A', 'B']);
  });

  it('orders threads by their newest message', () => {
    const items = buildConversationItems(
      [ptr('a1', 0), ptr('b1', 1), ptr('a2', 9)],
      [],
    );
    const out = groupThreadItems(items, table({ a1: 'A', a2: 'A', b1: 'B' }));
    // Thread A started first but ends last, so it sorts last.
    expect((out as ThreadGroupItem[]).map((g) => g.threadId)).toEqual(['B', 'A']);
  });

  it('prefers the authoritative count over what is loaded', () => {
    // The feed query is windowed at 500 — a long thread would undercount.
    const items = buildConversationItems([ptr('a', 0), ptr('b', 1)], []);
    const counts = new Map([['t1', 812]]);
    const g = groupThreadItems(items, table({ a: 't1', b: 't1' }), counts)[0] as ThreadGroupItem;
    expect(g.messageCount).toBe(812);
    expect(g.children).toHaveLength(2);
  });

  it('degrades to flat for messages whose body has not resolved', () => {
    // Past the 500-message window `getFm` returns null, so the thread is
    // unknowable — same rule the session grouper already follows.
    const items = buildConversationItems([ptr('loaded', 0), ptr('cold', 1)], []);
    const out = groupThreadItems(items, table({ loaded: 't1' }));
    expect(out).toHaveLength(2);
    expect(out[1].kind).toBe(ConversationItemKind.POINTER);
  });

  it('keeps internal messages in the timeline alongside packed threads', () => {
    const items = buildConversationItems([ptr('mail1', 0), ptr('note', 1), ptr('mail2', 2)], []);
    const out = groupThreadItems(items, table({ mail1: 't1', note: null, mail2: 't1' }));
    expect(out).toHaveLength(2);
    // The note keeps its own row and its place; the thread sorts to its newest.
    expect(out[0].kind).toBe(ConversationItemKind.POINTER);
    expect(out[1].kind).toBe(ConversationItemKind.THREAD_GROUP);
  });
});
