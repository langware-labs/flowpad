import { useMemo } from 'react';
import {
  Conversation,
  type ConversationParticipant,
  QueryRequest,
} from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';

/**
 * Stable identity key for a participant. user_id wins (cross-machine stable),
 * then email, then name as a last resort. Same keying must be applied on both
 * sides of the filter so the subset check is order-insensitive.
 */
function participantKey(p: ConversationParticipant): string {
  return (p.user_id || p.email || p.name || '').trim().toLowerCase();
}

export interface UseConversationsForContactsResult {
  conversations: Conversation[];
  isLoading: boolean;
}

/**
 * Conversations whose participants are a superset of ``selected``, ordered by
 * ``updated_date`` desc. Optionally scoped to a single project. Returns an
 * empty list when nothing is selected — the contact-first picker is the
 * intentional empty state, not a default-recents list.
 */
export function useConversationsForContacts(
  selected: ConversationParticipant[],
  projectId?: string | null,
  enabled: boolean = true,
): UseConversationsForContactsResult {
  const active = enabled && selected.length > 0;
  const request = useMemo(() => new QueryRequest({ type: Conversation.type }), []);
  const { data: conversations = [], isLoading } = useEntitiesQuery<Conversation>(
    request,
    { enabled: active },
  );

  const filtered = useMemo(() => {
    if (selected.length === 0) return [];
    const want = new Set(
      selected.map(participantKey).filter((k) => k.length > 0),
    );
    if (want.size === 0) return [];

    return conversations
      .filter((c) => {
        if (c.dismissed_at || c.archived_at) return false;
        if (projectId && c.project_id && c.project_id !== projectId) return false;
        const have = new Set(
          (c.participants ?? [])
            .map(participantKey)
            .filter((k) => k.length > 0),
        );
        for (const k of want) {
          if (!have.has(k)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const ta = a.updated_date ? new Date(a.updated_date).getTime() : 0;
        const tb = b.updated_date ? new Date(b.updated_date).getTime() : 0;
        return tb - ta;
      });
  }, [conversations, selected, projectId]);

  return { conversations: filtered, isLoading };
}
