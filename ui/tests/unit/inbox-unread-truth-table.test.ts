/**
 * Frontend half of the shared inbox-unread truth table.
 *
 * Consumes the SAME fixture as the backend formula test
 * (`tests/unit/test_inbox_unread_truth_table.py` over `flow_sdk.inbox.count_unread`)
 * and asserts `conversationFacets` — the function that decides which rows the
 * Unread view renders — agrees case-by-case. Catches semantic drift between
 * the backend scalar (`InboxManager.unread`) and the rendered list.
 */
import { describe, expect, it } from 'vitest';
import type { Conversation, FlowMessage, Invitation } from '@sdk';
import { conversationFacets } from '@src/components/conversation/conversation-category';
import table from '../../../tests/fixtures/inbox_unread_truth_table.json';

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

describe('inbox unread truth table — conversationFacets parity', () => {
  it.each(facetCases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const conv = c.conversations.find((x) => x.id === c.facets!.conversation)!;
    const firstFm = conv.pointers[0] ? c.messages[conv.pointers[0].fm] : undefined;
    const lastPtr = conv.pointers[conv.pointers.length - 1];
    const latestFm = lastPtr ? c.messages[lastPtr.fm] : undefined;
    const invitation = c.invitations.find(
      (i) => i.target_url_path === `/conversation/${conv.id}`,
    );

    const facets = conversationFacets({
      conv: { archived_at: conv.archived_at ?? undefined } as unknown as Conversation,
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
