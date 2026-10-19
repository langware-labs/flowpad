/**
 * `latestPointer` — "newest by ts", the frontend twin of
 * `Conversation.latest_message_ref()`.
 *
 * The two must agree: the backend computes the unread BADGE and the frontend
 * computes the unread ROW, so if they pick different messages the count and
 * the list disagree about the same conversation.
 */
import { describe, expect, it } from 'vitest';
import { latestPointer, type ConversationMessagePointer } from '@sdk';

const at = (min: number) => new Date(Date.UTC(2026, 6, 31, 12, min)).toISOString();
const p = (id: string, ts: string): ConversationMessagePointer => ({ id, type: 'flow_message', ts });

describe('latestPointer', () => {
  it('picks the last one when arrival order matches send order', () => {
    expect(latestPointer([p('a', at(0)), p('b', at(1)), p('c', at(2))])?.id).toBe('c');
  });

  it('does not pick the oldest from a newest-first backfill', () => {
    // THE regression: an ingested mailbox hands its history back newest-first,
    // so `pointers[length - 1]` is the OLDEST mail.
    expect(latestPointer([p('newest', at(10)), p('mid', at(5)), p('oldest', at(0))])?.id)
      .toBe('newest');
  });

  it('is not fooled by a late-arriving old message', () => {
    expect(latestPointer([p('a', at(0)), p('newest', at(10)), p('lateOld', at(1))])?.id)
      .toBe('newest');
  });

  it('returns null for an empty or absent list', () => {
    expect(latestPointer([])).toBeNull();
    expect(latestPointer(undefined)).toBeNull();
    expect(latestPointer(null)).toBeNull();
  });

  it('never lets an unparseable timestamp win', () => {
    expect(latestPointer([p('real', at(5)), p('junk', 'not-a-date')])?.id).toBe('real');
  });

  it('still returns something when every timestamp is junk', () => {
    // Degrade to "the first one", never to null — the row must still render.
    expect(latestPointer([p('a', 'x'), p('b', 'y')])?.id).toBe('a');
  });
});
