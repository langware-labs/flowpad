import { useMemo } from 'react';
import { Conversation, ExpressionNode, QueryRequest } from '@sdk';
import { recentConversationsRequest, whereKept } from '@src/components/stream-inbox-view/channel-owner';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { compareConversationsByRecency } from '@src/components/conversation/conversation-category';

export interface ProjectCollaboration {
  /** The most-recent collaboration conversation's id for this project, or null
   *  when none exists. Non-null is the "collaboration started" signal. */
  conversationId: string | null;
}

/** The project's newest open conversation, asked of the server where it keeps `project_id` (one row);
 *  where it does not, every conversation, newest first, matched here. */
function collaborationQuery(projectId: string): QueryRequest {
  const ofProject = whereKept('project_id', new ExpressionNode({ op: '$EQ', operands: ['project_id', projectId] }));
  return recentConversationsRequest(
    [...ofProject, ...whereKept('archived_at', new ExpressionNode({ op: '$IS_NULL', operands: ['archived_at'] }))],
    ofProject.length ? 1 : undefined,
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

  return useMemo(() => {
    const conv = projectId
      ? conversations
          .filter((c) => c.project_id === projectId && !c.archived_at)
          .sort(compareConversationsByRecency)[0] ?? null
      : null;
    return { conversationId: conv?.id ?? null };
  }, [conversations, projectId]);
}
