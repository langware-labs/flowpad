import {
  CollaborationSession,
  CollaborationSpace,
  QueryRequest,
  TypeId,
  dataManager,
} from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useMemo } from 'react';

export interface CollaborationSessionRow {
  id: string;
  name: string;
  /** Name of the owning space — used as chip in the activity strip. */
  spaceName: string;
  spaceId: string;
  updatedAt: string | null;
  membersCount: number;
  status: string;
}

const sessionsQuery = new QueryRequest({
  type: CollaborationSession.type,
  scope: [],
  name: 'useCollaborationSessions:sessions',
  query: null,
});

const spacesQuery = new QueryRequest({
  type: CollaborationSpace.type,
  scope: [],
  name: 'useCollaborationSessions:spaces',
  query: null,
});

/**
 * Last-X CollaborationSessions for the current project, ordered by updated_at desc.
 * Each row carries the owning space's name so the activity strip can render it
 * as a chip. Filtering is client-side (the total count should be small).
 */
export function useCollaborationSessions(options?: {
  projectId?: string | null;
  limit?: number;
}): { items: CollaborationSessionRow[]; isLoading: boolean } {
  const { projectId, limit = 20 } = options ?? {};

  const { data: sessions = [], isLoading: sessionsLoading } =
    useEntitiesQuery<CollaborationSession>(sessionsQuery);
  const { data: spaces = [], isLoading: spacesLoading } =
    useEntitiesQuery<CollaborationSpace>(spacesQuery);

  const items = useMemo(() => {
    const spaceById = new Map<string, CollaborationSpace>();
    for (const sp of spaces) spaceById.set(sp.id, sp);

    const filtered = sessions.filter((s) => {
      if (projectId && s.project_id !== projectId) return false;
      return true;
    });

    filtered.sort((a, b) => {
      const at = a.updated_at ? Date.parse(a.updated_at) : 0;
      const bt = b.updated_at ? Date.parse(b.updated_at) : 0;
      return bt - at;
    });

    return filtered.slice(0, limit).map<CollaborationSessionRow>((s) => {
      const space = s.space_id ? spaceById.get(s.space_id) ?? null : null;
      const spaceName =
        space?.host_name ? `${space.host_name}'s space` : space?.session_code ?? 'Space';
      return {
        id: s.id,
        name: s.displayName,
        spaceName,
        spaceId: s.space_id ?? '',
        updatedAt: s.updated_at ?? s.started_at ?? null,
        membersCount: s.members?.length ?? 0,
        status: s.status,
      };
    });
  }, [sessions, spaces, projectId, limit]);

  return { items, isLoading: sessionsLoading || spacesLoading };
}

/** Imperative helper for eagerly prefetching a single session from cache. */
export function getCollaborationSessionFromCache(id: string): CollaborationSession | null {
  try {
    return dataManager.getByTypeIdFromCache<CollaborationSession>(
      new TypeId(CollaborationSession.type, id),
    );
  } catch {
    return null;
  }
}
