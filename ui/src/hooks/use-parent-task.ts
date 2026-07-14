import { useMemo } from 'react';
import { QueryRequest, Task } from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';

/**
 * Live-resolve a member task's group parent. Watched query, so owner-side
 * parent edits repaint the member editor as soon as they land locally
 * (`sync-group` merges them into the parent mirror row).
 */
export function useParentTask(parentId?: string | null): Task | null {
  const request = useMemo(
    () => new QueryRequest({ type: Task.type, query: { id: parentId || '__none__' } }),
    [parentId],
  );
  const { data = [] } = useEntitiesQuery<Task>(request, { enabled: !!parentId });
  return (parentId && data[0]) || null;
}
