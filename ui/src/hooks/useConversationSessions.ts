import { QueryFilter, QueryRequest, RemoteWorkerSession } from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useMemo } from 'react';
import type { SessionAnchorIndex } from '@src/components/conversation/conversation-items';
import type { LiveSessionNote } from '@src/components/conversation/prompt-building';

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
        query: new QueryFilter({ match: { conversation_id: conversationId ?? '' } }),
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

/** Which side of a session the viewer is on; a row not synced yet is the guest's request. */
export function sessionRole(
  session: RemoteWorkerSession | null,
  cloudUserId: string | null | undefined,
): 'host' | 'guest' | 'observer' {
  return session ? session.roleFor(cloudUserId) : 'guest';
}

/**
 * The live session the viewer is the guest of in this conversation — awaiting approval or approved —
 * as the launch prompt names it. Null when there is none, or the viewer is its host.
 */
export function useLiveSessionNote(
  conversationId: string | null | undefined,
  cloudUserId: string | null | undefined,
): LiveSessionNote | null {
  const { byId } = useConversationSessions(conversationId);
  return useMemo(() => {
    const open = [...byId.values()]
      .filter((s) => s.prompt_limit == null && s.roleFor(cloudUserId) === 'guest')
      .filter((s) => ['pending', 'idle', 'running', 'error'].includes(s.status))
      .sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? ''))[0];
    if (!open?.id) return null;
    return {
      hostName: open.host_name?.trim() || 'the host',
      sessionId: open.id,
      approvedKinds: open.status === 'pending' ? null : open.effectiveTurnKinds,
    };
  }, [byId, cloudUserId]);
}
