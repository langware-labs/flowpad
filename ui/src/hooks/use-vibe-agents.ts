import { SubAgent, AgentKind, Project, QueryFilter, QueryRequest, TypeId } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { useMemo } from 'react';

/**
 * The project's `kind==vibe` agents, newest-last (created-date ASC) — the same
 * query the vibe process start embeds after the standard vibe agent. Memoized
 * request (the infinite-loop rule) and project-scoped (no unscoped get-all).
 */
export function useVibeAgents(projectId?: string | null) {
  const request = useMemo(
    () =>
      new QueryRequest({
        type: SubAgent.type,
        scope: projectId ? [new TypeId(Project.type, projectId)] : [],
        name: `vibeAgents:${projectId ?? 'none'}`,
        query: new QueryFilter({ match: { kind: AgentKind.Vibe }, order_by: { created_date: 'asc' } }),
      }),
    [projectId],
  );
  const { data: agents = [], isLoading, refetch } = useEntitiesQuery<SubAgent>(request, { enabled: !!projectId });
  return { agents, isLoading, refetch };
}
