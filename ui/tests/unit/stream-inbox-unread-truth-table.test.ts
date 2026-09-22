/**
 * Frontend half of the shared stream-inbox-unread truth table.
 *
 * The backend owns unread: `tests/unit/test_stream_inbox_unread_truth_table.py` pins each
 * conversation's `is_unread` flag and the badge count from `flow_sdk.stream_inbox.project_unread`
 * over the SAME fixture. This side pins that `conversationFacets` RENDERS that flag — a row hands
 * over the backend's answer instead of recomputing it — and still derives the two facets that are
 * display-only (archived, invitation), so the rendered Unread list matches the badge case by case.
 */
import { describe, expect, it } from 'vitest';
import type { Conversation, FlowMessage, Invitation } from '@sdk';
import { conversationFacets } from '@src/components/conversation/conversation-category';
import table from '../../../tests/fixtures/stream_inbox_unread_truth_table.json';

interface FixtureCase {
  name: string;
  conversations: Array<{
    id: string;
    archived_at: string | null;
    pointers: Array<{ fm: string; ts: string }>;
  }>;
  messages: Record<string, { is_read: boolean; sender_id: string; is_draft?: boolean; kind?: string }>;
  invitations: Array<{
    id: string;
    accepted: boolean;
    recipient_email: string;
    target_url_path?: string;
    target_type?: string;
    target_id?: string;
    expiration_at?: string;
  }>;
  expected: number;
  /** Present only for single-conversation cases where FE facets apply. */
  facets?: { conversation: string; isUnread: boolean; isArchived: boolean; isInvitation: boolean };
}

const viewer = {
  email: table.viewer.email,
  cloudUserId: table.viewer.cloud_user_id,
  localUserId: table.viewer.local_user_id,
};

const facetCases = (table.cases as FixtureCase[]).filter((c) => c.facets);

describe('stream inbox unread truth table — conversationFacets parity', () => {
  it.each(facetCases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const conv = c.conversations.find((x) => x.id === c.facets!.conversation)!;
    const firstFm = conv.pointers[0] ? c.messages[conv.pointers[0].fm] : undefined;
    const lastPtr = conv.pointers[conv.pointers.length - 1];
    const latestFm = lastPtr ? c.messages[lastPtr.fm] : undefined;
    const invitation = c.invitations.find(
      (i) => i.target_url_path === `/conversation/${conv.id}`,
    );

    const facets = conversationFacets({
      // The flag as the backend stamped it (`facets.isUnread` is what the backend test pins).
      conv: { archived_at: conv.archived_at ?? undefined, is_unread: c.facets!.isUnread } as unknown as Conversation,
      firstMessage: (firstFm ?? null) as unknown as FlowMessage | null,
      latestMessage: (latestFm ?? null) as unknown as FlowMessage | null,
      latestPtrTs: lastPtr?.ts ?? null,
      invitation: (invitation ?? null) as unknown as Invitation | null,
      viewer,
    });

    expect(facets.isUnread, 'isUnread').toBe(c.facets!.isUnread);
    expect(facets.isArchived, 'isArchived').toBe(c.facets!.isArchived);
    expect(facets.isInvitation, 'isInvitation').toBe(c.facets!.isInvitation);

    // The scalar the backend derives for this single-conversation world must
    // match what the row facets imply: one when visible-and-unread, plus any
    // pending membership invitations.
    const membershipPending = c.invitations.filter(
      (i) => i.target_type && i.target_id && !i.accepted && i.recipient_email === viewer.email,
    ).length;
    const rowContribution = !facets.isArchived && facets.isUnread ? 1 : 0;
    expect(rowContribution + membershipPending, 'scalar parity').toBe(c.expected);
  });
});
