import { QueryFilter, QueryRequest, Task } from '@sdk';
import { useEntitiesQuery, useProject } from '@sdk/react/hooks';
import { useCallback, useMemo, useState } from 'react';

/**
 * Hook to fetch the tasks of the currently active project.
 *
 * Matches on the `project_id` field rather than graph scope (`scope: []`): a
 * task is not graph-scoped under its project, it carries the project as a
 * field, so a scoped query returns nothing. That mirrors the predicate the
 * `list/task` surface gets server-side from `defaultScopeFilter(projectId)`
 * (`?user=false&projects=<id>`) — which is what keeps the rail's Tasks badge
 * counting what the list it opens shows. Two known asymmetries remain, both
 * also true of the bookmarks badge: the list's scope is user-togglable (switch
 * it to "All" and it shows more than the badge counted), and with no active
 * project the badge stays empty while the list falls back to user scope.
 *
 * Reactivity is handled by useEntitiesQuery's watchQuery — when the backend
 * saves a task entity, the DataOpMessage reaches the client via WebSocket
 * and the watched query automatically re-fetches. Note the query key now
 * varies by project, so each project switch costs one cold fetch (the old
 * unscoped key was shared); the payload is correspondingly smaller.
 */
export function useProjectTasks() {
  const { project } = useProject();
  const projectId = project?.id;

  // Optimistic exclusion: IDs hidden from the returned data until next refetch completes
  const [excludeIds, setExcludeIds] = useState<Set<string>>(new Set());

  // Memoized to avoid rebuilding the QueryFilter's ExpressionNode tree on every
  // render — the rail mounts this hook on every screen. Not a subscription
  // concern: useEntitiesQuery keys off the stringified query, not object identity.
  const queryRequest = useMemo(
    () =>
      new QueryRequest({
        type: 'task',
        scope: [],
        name: 'useProjectTasks',
        query: new QueryFilter({ match: { project_id: projectId ?? '' } }),
      }),
    [projectId],
  );

  const {
    data: tasks = [],
    isLoading,
    error,
    refetch: rawRefetch,
  } = useEntitiesQuery<Task>(queryRequest, {
    enabled: !!projectId,
  });

  // Wrap refetch to clear exclusions after it completes
  const refetch = useCallback(async () => {
    await rawRefetch();
    setExcludeIds(new Set());
  }, [rawRefetch]);

  // Optimistically hide tasks by ID (cleared on next refetch)
  const excludeTasks = useCallback((ids: string[]) => {
    setExcludeIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
  }, []);

  // Sort by created_date descending (immutable — no in-place mutation), then apply
  // the optimistic exclusion filter.
  //
  // Memoized because the rail (CollapsedSidebar) mounts this hook on EVERY screen
  // and re-reads it on every render: unmemoized, each render cloned the whole task
  // array and allocated two Date objects per comparison.
  const filteredTasks = useMemo(() => {
    const sorted = [...tasks].sort((a, b) => {
      const aTime = new Date(a.created_date || 0).getTime();
      const bTime = new Date(b.created_date || 0).getTime();
      return bTime - aTime;
    });
    return excludeIds.size > 0 ? sorted.filter((t) => !t.id || !excludeIds.has(t.id)) : sorted;
  }, [tasks, excludeIds]);

  return {
    data: filteredTasks,
    isLoading,
    error,
    refetch,
    excludeTasks,
  };
}
