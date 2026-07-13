import { useMemo } from 'react';
import { Conversation, QueryRequest } from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { compareConversationsByRecency } from '@src/components/conversation/conversation-category';

export interface ProjectCollaboration {
  /** The most-recent collaboration conversation's id for this project, or null
   *  when none exists. Non-null is the "collaboration started" signal. */
  conversationId: string | null;
}

// Module-const query — a fresh QueryRequest per render makes useEntitiesQuery
// infinite-loop (see project_useentitiesquery_memoize_request). Fetch all
// conversations; we filter by project client-side.
const conversationsQuery = new QueryRequest({ type: Conversation.type });

/**
 * Resolve whether a collaboration has already been started for a vibe workspace
 * (project). A collaboration is simply a Conversation whose `project_id` matches
 * — the collaborate share stamps it on the new conversation. Returns the most
 * recent match so the vibe header can flip the "Collaborate" icon to an
 * "open conversation" icon. Mirrors {@link useRemoteWorkerSessionForConversation}.
 */
export function useCollaborationForProject(
  projectId: string | null | undefined,
): ProjectCollaboration {
  const { data: conversations = [] } = useEntitiesQuery<Conversation>(conversationsQuery, {
    enabled: !!projectId,
  });

  return useMemo(() => {
    const conv = projectId
      ? conversations
          .filter((c) => c.project_id === projectId && !c.archived_at)
          .sort(compareConversationsByRecency)[0] ?? null
      : null;
    return { conversationId: conv?.id ?? null };
  }, [conversations, projectId]);
}
