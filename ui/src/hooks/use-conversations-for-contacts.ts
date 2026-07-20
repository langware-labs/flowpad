import { useMemo } from 'react';
import {
  Conversation,
  type ConversationParticipant,
  QueryRequest,
} from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { compareConversationsByRecency } from '@src/components/conversation/conversation-category';
// Single canonical keying, shared with ContactPicker / AddressBookButton so the
// picker's dedup and this subset-match agree on participant identity.
import { participantKey } from '@src/components/contact-picker/use-contacts';

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
          (c.members ?? [])
            .map(participantKey)
            .filter((k) => k.length > 0),
        );
        for (const k of want) {
          if (!have.has(k)) return false;
        }
        return true;
      })
      .sort(compareConversationsByRecency);
  }, [conversations, selected, projectId]);

  return { conversations: filtered, isLoading };
}
