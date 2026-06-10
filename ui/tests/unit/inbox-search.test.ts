/**
 * Inbox text search — matchingConversationIds is the pure filter behind the
 * InboxView search box: case-insensitive substring over message text,
 * collecting the owning conversation ids. Legacy local-DB rows can hold
 * non-string ``text`` payloads, so the matcher must coerce instead of throw.
 */
import { describe, expect, it } from 'vitest';
import { matchingConversationIds } from '@src/components/inbox-view/inbox-search';

const msg = (conversation_id: string | null, text: unknown) =>
  ({ conversation_id, text }) as Parameters<typeof matchingConversationIds>[0][number];

describe('matchingConversationIds', () => {
  it('matches case-insensitively and dedupes per conversation', () => {
    const ids = matchingConversationIds(
      [
        msg('c1', 'Hello WORLD'),
        msg('c1', 'world again'),
        msg('c2', 'unrelated'),
        msg('c3', 'the World is round'),
      ],
      'world',
    );
    expect(ids).toEqual(new Set(['c1', 'c3']));
  });

  it('trims the query and matches substrings mid-word', () => {
    const ids = matchingConversationIds([msg('c1', 'deployment finished')], '  ploy ');
    expect(ids).toEqual(new Set(['c1']));
  });

  it('empty or whitespace-only query matches nothing', () => {
    const messages = [msg('c1', 'anything')];
    expect(matchingConversationIds(messages, '')).toEqual(new Set());
    expect(matchingConversationIds(messages, '   ')).toEqual(new Set());
  });

  it('coerces non-string text instead of throwing', () => {
    expect(matchingConversationIds([msg('c1', { blob: true })], 'object')).toEqual(
      new Set(['c1']), // String({...}) → "[object Object]"
    );
    expect(matchingConversationIds([msg('c1', null), msg('c2', undefined)], 'x')).toEqual(
      new Set(),
    );
  });

  it('ignores messages without a conversation_id', () => {
    expect(matchingConversationIds([msg(null, 'needle')], 'needle')).toEqual(new Set());
  });
});
