import { QueryFilter, QueryRequest, RemoteWorkerSession } from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useMemo } from 'react';
import type { SessionAnchorIndex } from '@src/components/conversation/conversation-items';

export interface ConversationSessions {
  /** Every RemoteWorkerSession bound to this conversation, by id. */
  byId: ReadonlyMap<string, RemoteWorkerSession>;
  /** Session id → starting message id (null until the row has synced it). */
  anchors: SessionAnchorIndex;
}

const EMPTY: ConversationSessions = { byId: new Map(), anchors: new Map() };

/**
 * Every live session of a conversation, resolved ONCE at the conversation
 * level and handed down: the feed pins each one to its starting message and
 * every card reads its own status. A conversation holds many sessions (one
 * per opening prompt), so this is a map, never "the" session.
 */
export function useConversationSessions(conversationId: string | null | undefined): ConversationSessions {
  // Scope the fetch to THIS conversation's sessions — an unscoped query grows
  // with every session in the store. Memoize on the id so the request object is
  // stable across renders (a fresh QueryRequest per render infinite-loops
  // useEntitiesQuery — see project_useentitiesquery_memoize_request).
  const sessionsQuery = useMemo(
    () =>
      new QueryRequest({
        type: RemoteWorkerSession.type,
        scope: [],
        name: `useConversationSessions:${conversationId ?? 'none'}`,
        query: new QueryFilter({
          match: {
            op: '$AND',
            operands: [{ op: '$EQ', operands: ['conversation_id', conversationId ?? ''] }],
          } as Record<string, unknown>,
        }),
      }),
    [conversationId],
  );
  const { data: sessions = [] } = useEntitiesQuery<RemoteWorkerSession>(sessionsQuery, {
    enabled: !!conversationId,
  });
  return useMemo(() => {
    if (!conversationId) return EMPTY;
    const byId = new Map<string, RemoteWorkerSession>();
    const anchors = new Map<string, string | null>();
    for (const s of sessions) {
      if (s.conversation_id !== conversationId || !s.id) continue;
      byId.set(s.id, s);
      anchors.set(s.id, s.starting_message_id ?? null);
    }
    return { byId, anchors };
  }, [sessions, conversationId]);
}

/** Which side of a session the viewer is on. Host/guest ids are CLOUD ids. */
export function sessionRole(
  session: RemoteWorkerSession | null,
  cloudUserId: string | null | undefined,
): 'host' | 'guest' | 'observer' {
  if (!session) return 'guest';
  if (session.isHost(cloudUserId ?? null) || !!session.host_process_id) return 'host';
  if (session.guest_user_id && session.guest_user_id === cloudUserId) return 'guest';
  return 'observer';
}
