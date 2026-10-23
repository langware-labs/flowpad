import { useMemo } from 'react';
import { Conversation, ExpressionNode } from '@sdk';
import { recentConversationsRequest, whereKept } from '@src/components/stream-inbox-view/channel-owner';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { compareConversationsByRecency } from '@src/components/conversation/conversation-category';

/**
 * The most recent open conversations (not dismissed, not archived), ordered by
 * `updated_date` desc. Companion to `useConversationsForContacts` for pickers
 * with no contact scope (e.g. the Feed's Forward list). Nothing is fetched
 * while `enabled` is false. `excludeId` drops one conversation — the Feed's
 * suggested support conversation, which its primary action already targets.
 * `filter` narrows further (e.g. to helpdesk tickets) — a parameter rather than
 * a second copy of this query, so the not-dismissed/not-archived rule cannot
 * drift between callers.
 */
export function useRecentConversations(
  enabled: boolean,
  opts: { excludeId?: string; limit?: number; filter?: (c: Conversation) => boolean } = {},
): Conversation[] {
  const { excludeId, limit = 5, filter } = opts;
  // The server answers the newest open conversations — a page, not every conversation. With a filter
  // of its own (or one to exclude) the page is wider, so the slice still fills after it.
  const pageSize = filter ? 100 : limit + (excludeId ? 1 : 0);
  const request = useMemo(
    () =>
      recentConversationsRequest(
        [
          ...whereKept('dismissed_at', new ExpressionNode({ op: '$IS_NULL', operands: ['dismissed_at'] })),
          ...whereKept('archived_at', new ExpressionNode({ op: '$IS_NULL', operands: ['archived_at'] })),
        ],
        pageSize,
        'recent-conversations',
      ),
    [pageSize],
  );
  const { data: conversations = [] } = useEntitiesQuery<Conversation>(request, { enabled });

  return useMemo(
    () =>
      conversations
        .filter((c) => !c.dismissed_at && !c.archived_at && c.id !== excludeId)
        .filter((c) => (filter ? filter(c) : true))
        .sort(compareConversationsByRecency)
        .slice(0, limit),
    [conversations, excludeId, limit, filter],
  );
}
