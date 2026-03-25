import { Task } from '@sdk';
import { useCallback } from 'react';

interface UseTaskMutationsOptions {
  refetch: () => Promise<void>;
  excludeTasks: (ids: string[]) => void;
}

/**
 * Centralized task mutation logic with optimistic UI updates.
 * Every mutation: optimistically excludes affected tasks, saves to server,
 * then awaits refetch so the UI is in sync before the call resolves.
 *
 * Tasks are fetched with an unscoped query (scope: []) so they may belong to
 * any project.  Mutations therefore save with an empty scope so that the
 * backend authorises via any valid role path, avoiding 401s when the task's
 * owning project differs from the currently-selected project.
 */
export function useTaskMutations({ refetch, excludeTasks }: UseTaskMutationsOptions) {
  const archiveTask = useCallback(
    async (task: Task) => {
      task.status = 'archived';
      task.archived_at = new Date().toISOString();
      if (task.id) excludeTasks([task.id]);
      await task.save([]);
      await refetch();
    },
    [excludeTasks, refetch],
  );

  const deleteTask = useCallback(
    async (task: Task) => {
      if (task.id) excludeTasks([task.id]);
      await task.delete();
      await refetch();
    },
    [excludeTasks, refetch],
  );

  const setTaskReminder = useCallback(
    async (task: Task, date: Date) => {
      task.start_date = date.toISOString();
      task.status = 'pending';
      if (task.id) excludeTasks([task.id]);
      await task.save([]);
      await refetch();
    },
    [excludeTasks, refetch],
  );

  /**
   * Shared removal: archives on active/pending tabs, deletes on archived tab.
   */
  const removeTasks = useCallback(
    async (tasks: Task[]) => {
      if (tasks.length === 0) return;
      const ids = tasks.map((t) => t.id).filter(Boolean);
      excludeTasks(ids);

      const toArchive = tasks.filter((t) => t.status !== 'archived' && !t.archived_at);
      const toDelete = tasks.filter((t) => t.status === 'archived' || !!t.archived_at);

      const now = new Date().toISOString();
      await Promise.all([
        ...toArchive.map((task) => {
          task.status = 'archived';
          task.archived_at = now;
          return task.save([]);
        }),
        ...toDelete.map((task) => task.delete()),
      ]);
      await refetch();
    },
    [excludeTasks, refetch],
  );

  const bulkReminder = useCallback(
    async (tasks: Task[], date: Date) => {
      const ids = tasks.map((t) => t.id).filter(Boolean);
      excludeTasks(ids);
      const isoDate = date.toISOString();
      await Promise.all(
        tasks.map((task) => {
          task.start_date = isoDate;
          task.status = 'pending';
          return task.save([]);
        }),
      );
      await refetch();
    },
    [excludeTasks, refetch],
  );

  return { archiveTask, deleteTask, setTaskReminder, removeTasks, bulkReminder };
}
