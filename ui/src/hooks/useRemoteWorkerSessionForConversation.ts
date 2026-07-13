import { QueryRequest, RemoteWorkerSession } from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { byWorkerSessionActivityDesc } from '@src/hooks/useRemoteWorkerSessions';
import { useMemo } from 'react';

/** Statuses that mean the session's worker is actively mid-turn. Drives the
 *  soft pulse on the run chip + the open-worker-session icon. */
const IN_FLIGHT_STATUSES = new Set(['running', 'active', 'busy', 'working']);

export interface ConversationWorkerSession {
  /** True when a worker session exists for this conversation. */
  exists: boolean;
  projectId: string | null;
  roomId: string | null;
  sessionId: string | null;
  /** User-facing chip label — `<Host>'s session`. */
  label: string;
  /** True while the session's worker is mid-turn. */
  inFlight: boolean;
}

// Module-const query — a fresh QueryRequest per render makes useEntitiesQuery
// infinite-loop (see project_useentitiesquery_memoize_request). Scope `[]`
// fetches every session; we filter by conversation client-side (a conversation
// holds one session).
const sessionsQuery = new QueryRequest({
  type: RemoteWorkerSession.type,
  scope: [],
  name: 'useRemoteWorkerSessionForConversation:sessions',
  query: null,
});

/** The user-facing label for the conversation's worker-session run chip. The
 *  single tweakable string — never uses the word "room". */
export function sessionChipLabel({ hostName }: { hostName?: string | null }): string {
  const name = hostName?.trim();
  return `${name || 'Worker'}'s session`;
}

/**
 * Resolve the RemoteWorkerSession bound to a conversation (the "working
 * session" created by execute_prompt). Mirrors {@link useRemoteWorkerSessions}
 * but keys on `conversation_id` instead of the room, and reads everything off
 * the denormalized session — no CollaborationRoom fetch needed for the label or
 * the nav. Resolve ONCE at the conversation level and hand the result down, so
 * N bubbles don't each subscribe.
 */
export function useRemoteWorkerSessionForConversation(
  conversationId: string | null | undefined,
): ConversationWorkerSession {
  const { data: sessions = [] } = useEntitiesQuery<RemoteWorkerSession>(sessionsQuery);

  return useMemo(() => {
    const session = conversationId
      ? sessions
          .filter((s) => s.conversation_id === conversationId)
          .sort(byWorkerSessionActivityDesc)[0] ?? null
      : null;

    const hostName = session?.host_name ?? session?.host_user_id ?? null;
    return {
      exists: !!session,
      projectId: session?.project_id ?? null,
      roomId: session?.collaboration_room_id ?? null,
      sessionId: session?.id ?? null,
      label: sessionChipLabel({ hostName }),
      inFlight: !!session && IN_FLIGHT_STATUSES.has((session.status ?? '').toLowerCase()),
    };
  }, [sessions, conversationId]);
}
