/**
 * Truth table for ``shouldShowSoloSendNotice`` — the computed (never
 * persisted) "you're the only participant" notice shown after the local user
 * sends into a shared conversation everyone else has left.
 */

import { describe, expect, it } from 'vitest';
import {
  ConversationItemKind,
  shouldShowSoloSendNotice,
  type ConversationItem,
  type SoloSendNoticeParams,
} from '@src/components/conversation/conversation-items';

const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const pointerItem: ConversationItem = {
  kind: ConversationItemKind.POINTER,
  key: 'm1',
  messageId: 'm1',
  timestamp: '2026-07-07T10:00:00Z',
  sortAt: 1,
};

const draftItem: ConversationItem = {
  kind: ConversationItemKind.DRAFT,
  key: 'draft:d1',
  draft: { id: 'd1' } as any,
  sortAt: 2,
};

function params(overrides: Partial<SoloSendNoticeParams> = {}): SoloSendNoticeParams {
  return {
    remote: true,
    helpdesk: false,
    rosterReady: true,
    participants: [{ user_id: ME }],
    cloudUserId: ME,
    lastItem: pointerItem,
    lastMessageSenderId: ME,
    ...overrides,
  };
}

describe('shouldShowSoloSendNotice', () => {
  it('true: solo roster and the last message is mine', () => {
    expect(shouldShowSoloSendNotice(params())).toBe(true);
  });

  it('false: another participant is still in the conversation', () => {
    expect(shouldShowSoloSendNotice(params({ participants: [{ user_id: ME }, { user_id: OTHER }] }))).toBe(false);
  });

  it('false: sole participant is someone else (not the local user)', () => {
    expect(shouldShowSoloSendNotice(params({ participants: [{ user_id: OTHER }] }))).toBe(false);
  });

  it('false: last message was sent by someone else', () => {
    expect(shouldShowSoloSendNotice(params({ lastMessageSenderId: OTHER }))).toBe(false);
  });

  it('false: last item is an unsent draft', () => {
    expect(shouldShowSoloSendNotice(params({ lastItem: draftItem, lastMessageSenderId: null }))).toBe(false);
  });

  it('false: local-only conversation (not remote)', () => {
    expect(shouldShowSoloSendNotice(params({ remote: false }))).toBe(false);
  });

  it('false: helpdesk conversation (roster masks responders)', () => {
    expect(shouldShowSoloSendNotice(params({ helpdesk: true }))).toBe(false);
  });

  it('false: roster not fetched yet', () => {
    expect(shouldShowSoloSendNotice(params({ rosterReady: false }))).toBe(false);
  });

  it('false: no cloud user (signed out)', () => {
    expect(shouldShowSoloSendNotice(params({ cloudUserId: null }))).toBe(false);
  });

  it('false: empty conversation (no last item)', () => {
    expect(shouldShowSoloSendNotice(params({ lastItem: null, lastMessageSenderId: null }))).toBe(false);
  });

  it('false: empty roster (visibility anomaly, never claim solo)', () => {
    expect(shouldShowSoloSendNotice(params({ participants: [] }))).toBe(false);
  });
});
