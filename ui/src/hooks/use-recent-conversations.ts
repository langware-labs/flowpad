import { useMemo } from 'react';
import { Conversation, QueryRequest } from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { compareConversationsByRecency } from '@src/components/conversation/conversation-category';

/**
 * The most recent open conversations (not dismissed, not archived), ordered by
 * `updated_date` desc. Companion to `useConversationsForContacts` for pickers
 * with no contact scope (e.g. the Feed's Forward list). Nothing is fetched
 * while `enabled` is false. `excludeId` drops one conversation — the Feed's
 * suggested support conversation, which its primary action already targets.
 */
export function useRecentConversations(
  enabled: boolean,
  opts: { excludeId?: string; limit?: number } = {},
): Conversation[] {
  const { excludeId, limit = 5 } = opts;
  const request = useMemo(() => new QueryRequest({ type: Conversation.type }), []);
  const { data: conversations = [] } = useEntitiesQuery<Conversation>(request, { enabled });

  return useMemo(
    () =>
      conversations
        .filter((c) => !c.dismissed_at && !c.archived_at && c.id !== excludeId)
        .sort(compareConversationsByRecency)
        .slice(0, limit),
    [conversations, excludeId, limit],
  );
}
