/**
 * Switch proof for the inbox REORDER bug.
 *
 * Symptom: the inbox (and the home RecentConversationsStrip) re-shuffled the
 * conversation order on every open. RCA cause: both surfaces sorted by
 * `updated_date` descending with NO tiebreaker, so rows with equal or missing
 * timestamps fell back to the server's result order — which is not stable across
 * fetches. The fix adds a stable `id` tiebreaker (`compareConversationsByRecency`),
 * making the sort a total order.
 *
 * This test drives the REAL shared comparator over REAL `Conversation` entities
 * and proves the switch BOTH directions: WITH the tiebreaker, equal-timestamp
 * rows keep a fixed order regardless of input order; a comparator WITHOUT the
 * tiebreaker (the pre-fix behavior) reshuffles with the input order.
 */
import { describe, it, expect } from 'vitest';
import { Conversation } from '@sdk';
import { compareConversationsByRecency } from '@src/components/conversation/conversation-category';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const ID_C = '33333333-3333-4333-8333-333333333333';
const ID_NEW = '44444444-4444-4444-8444-444444444444';

const conv = (id: string, updated_date?: string) =>
  new Conversation({ id, updated_date, message_ids: '[]' });

describe('compareConversationsByRecency (inbox / strip shared sort)', () => {
  it('orders the most recently updated conversation first', () => {
    const older = conv(ID_A, '2026-06-01T00:00:00Z');
    const newer = conv(ID_B, '2026-06-02T00:00:00Z');
    const out = [older, newer].sort(compareConversationsByRecency).map((c) => c.id);
    expect(out).toEqual([ID_B, ID_A]);
  });

  it('breaks equal-timestamp ties by id, so order is FIXED regardless of input order', () => {
    const ts = '2026-06-01T00:00:00Z';
    const x = conv(ID_A, ts);
    const y = conv(ID_B, ts);
    const z = conv(ID_C, ts);

    // Three different "server orders" of the same equal-timestamp set.
    const order1 = [x, y, z].sort(compareConversationsByRecency).map((c) => c.id);
    const order2 = [z, x, y].sort(compareConversationsByRecency).map((c) => c.id);
    const order3 = [y, z, x].sort(compareConversationsByRecency).map((c) => c.id);

    // Fixed output regardless of input order — no reshuffle on open.
    expect(order1).toEqual(order2);
    expect(order2).toEqual(order3);
    expect(order1).toEqual([ID_A, ID_B, ID_C]); // ascending id tiebreak

    // SWITCH (negative direction): the PRE-FIX comparator — same recency compare
    // but NO tiebreaker — leaves equal-timestamp rows in input order (Array.sort
    // is stable), so the same set in two server orders renders differently. That
    // input-order dependence is exactly the on-open reshuffle the fix removed.
    const preFixCompare = (a: Conversation, b: Conversation) => {
      const ta = a.updated_date ? new Date(a.updated_date).getTime() : 0;
      const tb = b.updated_date ? new Date(b.updated_date).getTime() : 0;
      return tb - ta;
    };
    const pre1 = [x, y, z].sort(preFixCompare).map((c) => c.id);
    const pre2 = [z, x, y].sort(preFixCompare).map((c) => c.id);
    expect(pre1).not.toEqual(pre2);
  });

  it('keeps missing-timestamp rows deterministic (they sort last, ordered by id)', () => {
    const dated = conv(ID_NEW, '2026-06-01T00:00:00Z');
    const undated1 = conv(ID_A, undefined);
    const undated2 = conv(ID_B, undefined);

    const r1 = [undated2, dated, undated1].sort(compareConversationsByRecency).map((c) => c.id);
    const r2 = [undated1, undated2, dated].sort(compareConversationsByRecency).map((c) => c.id);

    expect(r1).toEqual(r2); // stable regardless of input order
    expect(r1[0]).toBe(ID_NEW); // the only dated row is newest → first
    expect(r1.slice(1)).toEqual([ID_A, ID_B]); // undated rows by ascending id
  });
});
