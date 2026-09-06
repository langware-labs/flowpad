import { QueryRequest, RemoteWorkerSession } from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useMemo } from 'react';

export interface SharedSessionRow {
  id: string;
  hostName: string;
  guestName: string;
  status: string;
}

const sessionsQuery = new QueryRequest({
  type: RemoteWorkerSession.type,
  scope: [],
  name: 'useRemoteWorkerSessions:sessions',
  query: null,
});

/** Newest-activity-first comparator for RemoteWorkerSessions (last_activity_at,
 *  falling back to started_at). */
export function byWorkerSessionActivityDesc(
  a: RemoteWorkerSession,
  b: RemoteWorkerSession,
): number {
  const at = Date.parse(a.last_activity_at ?? a.started_at ?? '') || 0;
  const bt = Date.parse(b.last_activity_at ?? b.started_at ?? '') || 0;
  return bt - at;
}

/**
 * The shared sessions (RemoteWorkerSession) that live inside a collaboration
 * room, newest activity first. Host/guest display names are denormalized onto
 * the session at write time (see execute_prompt.py), so no cross-roster id
 * resolution is needed here. Filtering is client-side (a room holds few
 * sessions).
 */
export function useRemoteWorkerSessions(
  collaborationRoomId: string | null,
): { items: SharedSessionRow[]; isLoading: boolean } {
  const { data: sessions = [], isLoading } =
    useEntitiesQuery<RemoteWorkerSession>(sessionsQuery);

  const items = useMemo(
    () =>
      sessions
        .filter((s) => (collaborationRoomId ? s.collaboration_room_id === collaborationRoomId : true))
        .sort(byWorkerSessionActivityDesc)
        .map<SharedSessionRow>((s) => ({
          id: s.id,
          hostName: s.host_name ?? s.host_user_id ?? 'unknown',
          guestName: s.guest_name ?? s.guest_user_id ?? 'unknown',
          status: s.status ?? 'idle',
        })),
    [sessions, collaborationRoomId],
  );

  return { items, isLoading };
}
