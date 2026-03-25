import { Comment, QueryRequest, Task } from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';

/**
 * Hook to fetch all comments for a specific task
 */
export function useTaskComments(task: Task) {
  const taskTypeId = task.typeId;

  // Create the query request
  const queryRequest = new QueryRequest({
    type: 'comment',
    scope: taskTypeId ? [taskTypeId] : [],
    name: 'useTaskComments',
  });

  const {
    data: comments = [],
    isLoading,
    error,
    refetch,
  } = useEntitiesQuery<Comment>(queryRequest, {
    enabled: !!taskTypeId,
  });

  // Sort comments by created_date in ascending order (oldest first)
  const sortedComments = comments.sort((a, b) => {
    const aTime = new Date(a.created_date || 0).getTime();
    const bTime = new Date(b.created_date || 0).getTime();
    return aTime - bTime; // Ascending order (oldest first)
  });

  return {
    data: sortedComments,
    isLoading,
    error,
    refetch,
  };
}
