import { Comment, QueryRequest, Task } from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useCallback, useMemo } from 'react';

/**
 * List + create + delete `Comment` entities scoped to a task.
 *
 * Parent linkage is the canonical `parent_type_id` ("<type>-<id>") on the
 * comment itself, filtered client-side. We DO also pass the scope to
 * `comment.save()` so the backend's add_child relationship lands, but the
 * entity-graph scope query is permissive (returns matching-type entities
 * regardless of parent), so without the parent_type_id filter every task would
 * see every other task's comments. Mirrors the use-doc-comments pattern.
 */
export function useTaskComments(task: Task) {
  const taskTypeId = task.typeId;
  const parentKey = taskTypeId ? taskTypeId.toString() : null;

  const queryRequest = useMemo(
    () =>
      new QueryRequest({
        type: 'comment',
        scope: taskTypeId ? [taskTypeId] : [],
        name: 'useTaskComments',
      }),
    [taskTypeId],
  );

  const {
    data: rawComments = [],
    isLoading,
    error,
    refetch,
  } = useEntitiesQuery<Comment>(queryRequest, {
    enabled: !!taskTypeId,
  });

  // Keep only comments tagged for THIS task, oldest first. The server-side
  // scope query returns every comment regardless of parent, so the
  // parent_type_id check is what keeps task A's comments out of task B's view.
  const comments = useMemo<Comment[]>(
    () =>
      rawComments
        .filter((c) => !!parentKey && c.parent_type_id === parentKey)
        .sort((a, b) => {
          const aTime = new Date(a.created_date || 0).getTime();
          const bTime = new Date(b.created_date || 0).getTime();
          return aTime - bTime; // Ascending (oldest first)
        }),
    [rawComments, parentKey],
  );

  const addComment = useCallback(
    async (text: string): Promise<void> => {
      if (!taskTypeId || !parentKey || !text.trim()) return;
      const comment = new Comment({
        raw_content: text.trim(),
        parent_type_id: parentKey,
      });
      await comment.save(taskTypeId);
      await refetch();
    },
    [taskTypeId, parentKey, refetch],
  );

  const deleteComment = useCallback(
    async (comment: Comment): Promise<void> => {
      await comment.delete();
      await refetch();
    },
    [refetch],
  );

  return {
    data: comments,
    isLoading,
    error,
    refetch,
    addComment,
    deleteComment,
  };
}
