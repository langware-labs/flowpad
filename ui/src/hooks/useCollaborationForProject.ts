import { useMemo } from 'react';
import { Conversation, ExpressionNode, QueryRequest } from '@sdk';
import { recentConversationsRequest } from '@src/components/stream-inbox-view/channel-owner';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';

export interface ProjectCollaboration {
  /** The most-recent collaboration conversation's id for this project, or null
   *  when none exists. Non-null is the "collaboration started" signal. */
  conversationId: string | null;
}

/** The project's newest open conversation (one row). */
function collaborationQuery(projectId: string): QueryRequest {
  return recentConversationsRequest(
    [
      new ExpressionNode({ op: '$EQ', operands: ['project_id', projectId] }),
      new ExpressionNode({ op: '$IS_NULL', operands: ['archived_at'] }),
    ],
    1,
    `collaboration:${projectId}`,
  );
}

/**
 * Resolve whether a collaboration has already been started for a vibe workspace
 * (project). A collaboration is simply a Conversation whose `project_id` matches
 * — the collaborate share stamps it on the new conversation. Returns the most
 * recent match so the vibe header can flip the "Collaborate" icon to an
 * "open conversation" icon. Mirrors {@link useConversationSessions}.
 */
export function useCollaborationForProject(
  projectId: string | null | undefined,
): ProjectCollaboration {
  // Memoized — a fresh QueryRequest per render makes useEntitiesQuery re-subscribe.
  const conversationsQuery = useMemo(() => collaborationQuery(projectId ?? ''), [projectId]);
  const { data: conversations = [] } = useEntitiesQuery<Conversation>(conversationsQuery, {
    enabled: !!projectId,
  });

  return { conversationId: (projectId && conversations[0]?.id) || null };
}
