/**
 * Unit tests for the shared conversation-category classifier.
 *
 * Pure logic — no backend. Covers the priority order of `primary` and the
 * viewer-relativity invariant: the SAME conversation is an invitation row for
 * the recipient but a normal row for the sender.
 */
import { describe, expect, it } from 'vitest';
import {
  Conversation,
  ConversationKind,
  FlowMessage,
  FlowMessageKind,
  Invitation,
} from '@sdk';
import {
  conversationFacets,
  type CategoryInputs,
} from '@src/components/conversation/conversation-category';

// Minimal shaped stand-ins — the classifier only reads the fields below.
function makeInputs(over: {
  kind?: ConversationKind;
  archived_at?: string | null;
  latestPtrTs?: string | null;
  firstKind?: FlowMessageKind;
  latestRead?: boolean;
  accepted?: boolean;
  recipientEmail?: string | null;
  viewerEmail?: string;
}): CategoryInputs {
  const conv = {
    kind: over.kind ?? ConversationKind.DIRECT,
    archived_at: over.archived_at ?? null,
  } as unknown as Conversation;
  const firstMessage =
    over.firstKind !== undefined ? ({ kind: over.firstKind } as unknown as FlowMessage) : null;
  const latestMessage =
    over.latestRead !== undefined
      ? ({ is_read: over.latestRead } as unknown as FlowMessage)
      : null;
  const invitation =
    over.recipientEmail !== undefined || over.accepted !== undefined
      ? ({ recipient_email: over.recipientEmail ?? null, accepted: over.accepted ?? false } as unknown as Invitation)
      : null;
  return {
    conv,
    firstMessage,
    latestMessage,
    latestPtrTs: over.latestPtrTs ?? null,
    invitation,
    viewer: { email: over.viewerEmail ?? 'me@x.test', cloudUserId: null },
  };
}

describe('conversationFacets', () => {
  it('plain direct conversation with a read latest message → active', () => {
    const f = conversationFacets(makeInputs({ latestRead: true }));
    expect(f).toEqual({ kind: 'direct', isInvitation: false, isArchived: false, isUnread: false });
  });

  it('unread latest message → unread', () => {
    const f = conversationFacets(makeInputs({ latestRead: false }));
    expect(f.isUnread).toBe(true);
  });

  it('community kind → community facet set', () => {
    const f = conversationFacets(makeInputs({ kind: ConversationKind.COMMUNITY, latestRead: false }));
    expect(f.kind).toBe('community');
  });

  it('archived_at after the latest pointer ts → archived', () => {
    const f = conversationFacets(makeInputs({
      archived_at: '2026-06-10T12:00:00Z',
      latestPtrTs: '2026-06-10T11:00:00Z',
      latestRead: true,
    }));
    expect(f.isArchived).toBe(true);
  });

  it('a message newer than archived_at auto-revives the row (not archived)', () => {
    const f = conversationFacets(makeInputs({
      archived_at: '2026-06-10T11:00:00Z',
      latestPtrTs: '2026-06-10T12:00:00Z',
      latestRead: true,
    }));
    expect(f.isArchived).toBe(false);
  });

  it('pending invitation, viewer IS the recipient → invitation (always unread)', () => {
    const f = conversationFacets(makeInputs({
      firstKind: FlowMessageKind.INVITATION,
      accepted: false,
      recipientEmail: 'me@x.test',
      viewerEmail: 'me@x.test',
    }));
    expect(f.isInvitation).toBe(true);
    expect(f.isUnread).toBe(true);
  });

  it('viewer-relativity: same invitation conversation is NOT an invitation row for the sender', () => {
    const f = conversationFacets(makeInputs({
      firstKind: FlowMessageKind.INVITATION,
      accepted: false,
      recipientEmail: 'other@x.test',
      viewerEmail: 'me@x.test', // I sent it; I'm not the recipient
      latestRead: true,
    }));
    expect(f.isInvitation).toBe(false);
  });

  it('accepted invitation is no longer an invitation row', () => {
    const f = conversationFacets(makeInputs({
      firstKind: FlowMessageKind.INVITATION,
      accepted: true,
      recipientEmail: 'me@x.test',
      viewerEmail: 'me@x.test',
      latestRead: true,
    }));
    expect(f.isInvitation).toBe(false);
  });

  it('orthogonal axes co-occur: a row can be invitation + community + archived at once', () => {
    const f = conversationFacets(makeInputs({
      kind: ConversationKind.COMMUNITY,
      archived_at: '2026-06-10T12:00:00Z',
      latestPtrTs: '2026-06-10T11:00:00Z',
      firstKind: FlowMessageKind.INVITATION,
      accepted: false,
      recipientEmail: 'me@x.test',
      viewerEmail: 'me@x.test',
    }));
    expect(f.isInvitation).toBe(true);
    expect(f.kind).toBe('community');
    expect(f.isArchived).toBe(true);
  });
});
