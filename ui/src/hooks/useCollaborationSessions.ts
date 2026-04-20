import {
  CollaborationSession,
  Project,
  QueryRequest,
  TypeId,
  dataManager,
} from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useMemo } from 'react';

export interface CollaborationSessionRow {
  id: string;
  name: string;
  /** Owning project id — same value as `projectId` in the dock URL segment. */
  projectId: string;
  /** Name of the owning project — used as chip in the activity strip. */
  projectName: string;
  /** Display name of the session host (who started the meeting). */
  hostName: string | null;
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

const projectsQuery = new QueryRequest({
  type: Project.type,
  scope: [],
  name: 'useCollaborationSessions:projects',
  query: null,
});

/**
 * Last-X CollaborationSessions for the current project, ordered by updated_at desc.
 * Each row carries the owning project's name so the activity strip can render it
 * as a chip. Filtering is client-side (the total count should be small).
 */
export function useCollaborationSessions(options?: {
  projectId?: string | null;
  limit?: number;
}): { items: CollaborationSessionRow[]; isLoading: boolean } {
  const { projectId, limit = 20 } = options ?? {};

  const { data: sessions = [], isLoading: sessionsLoading } =
    useEntitiesQuery<CollaborationSession>(sessionsQuery);
  const { data: projects = [], isLoading: projectsLoading } =
    useEntitiesQuery<Project>(projectsQuery);

  const items = useMemo(() => {
    const projectById = new Map<string, Project>();
    for (const p of projects) projectById.set(p.id, p);

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
      const project = s.project_id ? projectById.get(s.project_id) ?? null : null;
      const projectName = project?.displayName ?? 'Project';
      const pid = s.project_id ?? '';
      return {
        id: s.id,
        name: s.displayName,
        projectId: pid,
        projectName,
        hostName: s.host_name ?? null,
        updatedAt: s.updated_at ?? s.started_at ?? null,
        membersCount: s.members?.length ?? 0,
        status: s.status,
      };
    });
  }, [sessions, projects, projectId, limit]);

  return { items, isLoading: sessionsLoading || projectsLoading };
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
