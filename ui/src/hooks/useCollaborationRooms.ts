import {
  CollaborationRoom,
  Project,
  QueryRequest,
  TypeId,
  dataManager,
} from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useMemo } from 'react';

export interface CollaborationRoomRow {
  id: string;
  name: string;
  /** Owning project id — same value as `projectId` in the dock URL segment. */
  projectId: string;
  /** Name of the owning project — used as chip in the activity strip. */
  projectName: string;
  /** Display name of the room host (who started the room). */
  hostName: string | null;
  updatedAt: string | null;
  membersCount: number;
  status: string;
}

const roomsQuery = new QueryRequest({
  type: CollaborationRoom.type,
  scope: [],
  name: 'useCollaborationRooms:rooms',
  query: null,
});

const projectsQuery = new QueryRequest({
  type: Project.type,
  scope: [],
  name: 'useCollaborationRooms:projects',
  query: null,
});

/**
 * Last-X CollaborationRooms for the current project, ordered by updated_at desc.
 * Each row carries the owning project's name so the activity strip can render
 * it as a chip. Filtering is client-side (the total count should be small).
 */
export function useCollaborationRooms(options?: {
  projectId?: string | null;
  limit?: number;
}): { items: CollaborationRoomRow[]; isLoading: boolean } {
  const { projectId, limit = 20 } = options ?? {};

  const { data: rooms = [], isLoading: roomsLoading } =
    useEntitiesQuery<CollaborationRoom>(roomsQuery);
  const { data: projects = [], isLoading: projectsLoading } =
    useEntitiesQuery<Project>(projectsQuery);

  const items = useMemo(() => {
    const projectById = new Map<string, Project>();
    for (const p of projects) projectById.set(p.id, p);

    const filtered = rooms.filter((r) => {
      if (projectId && r.project_id !== projectId) return false;
      return true;
    });

    filtered.sort((a, b) => {
      const at = a.updated_at ? Date.parse(a.updated_at) : 0;
      const bt = b.updated_at ? Date.parse(b.updated_at) : 0;
      return bt - at;
    });

    return filtered.slice(0, limit).map<CollaborationRoomRow>((r) => {
      const project = r.project_id ? projectById.get(r.project_id) ?? null : null;
      const projectName = project?.displayName ?? 'Project';
      const pid = r.project_id ?? '';
      return {
        id: r.id,
        name: r.displayName,
        projectId: pid,
        projectName,
        hostName: r.host_name ?? null,
        updatedAt: r.updated_at ?? r.started_at ?? null,
        membersCount: r.members?.length ?? 0,
        status: r.status,
      };
    });
  }, [rooms, projects, projectId, limit]);

  return { items, isLoading: roomsLoading || projectsLoading };
}

/** Imperative helper for eagerly prefetching a single room from cache. */
export function getCollaborationRoomFromCache(id: string): CollaborationRoom | null {
  try {
    return dataManager.getByTypeIdFromCache<CollaborationRoom>(
      new TypeId(CollaborationRoom.type, id),
    );
  } catch {
    return null;
  }
}
