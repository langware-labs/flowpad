import { QueryRequest, Task } from '@sdk';
import { useEntitiesQuery, useProject } from '@sdk/react/hooks';
import { useCallback, useMemo, useState } from 'react';

/**
 * Hook to fetch all tasks visible to the current user.
 *
 * Uses an unscoped query (scope: []) so that tasks created via webhook
 * (which are saved under the @local desktop project) are visible even when
 * the user has selected a different project in the sidebar.
 *
 * Reactivity is handled by useEntitiesQuery's watchQuery — when the backend
 * saves a task entity, the DataOpMessage reaches the client via WebSocket
 * and the watched query automatically re-fetches.
 */
export function useProjectTasks() {
  const { project } = useProject();
  const projectTypeId = project?.typeId;

  // Optimistic exclusion: IDs hidden from the returned data until next refetch completes
  const [excludeIds, setExcludeIds] = useState<Set<string>>(new Set());

  const queryRequest = new QueryRequest({
    type: 'task',
    scope: [],
    name: 'useProjectTasks',
  });

  const {
    data: tasks = [],
    isLoading,
    error,
    refetch: rawRefetch,
  } = useEntitiesQuery<Task>(queryRequest, {
    enabled: !!projectTypeId,
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
  // array and allocated two Date objects per comparison over an unscoped corpus.
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
    projectTypeId,
  };
}
