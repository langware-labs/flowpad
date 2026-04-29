import { useEffect } from 'react';
import {
  ContextEntitiesEnum,
  dataContext,
  Project,
  TypeId,
} from '@sdk';
import type { ITask } from '@sdk/entities/task';

/**
 * Pushes the *task's* mapped project into the global active-project context
 * for as long as the calling component is mounted. The conversation view (or
 * any task-bound view) is the "dictator" — when it mounts, the footer follows;
 * when the task has no mapped project, the footer falls to null and shows the
 * red "Select Project" pill.
 *
 * On unmount we deliberately do NOT revert. Per the agreed UX, the most
 * recently mounted dictating entity wins, and stays in effect until another
 * dictating entity (or the user via OpenProjectComponent) changes it.
 */
export function useSyncContextProject(task: ITask | null | undefined): void {
  const taskMeta = (task?.metadata as Record<string, unknown> | undefined) ?? {};
  const projectId = taskMeta.project_id as string | undefined;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (projectId) {
          const projectTypeId = new TypeId(Project.type, projectId);
          // Avoid no-op writes that would still trigger refreshProject churn.
          if (dataContext.project?.id === projectId) return;
          if (cancelled) return;
          await dataContext.setContextEntityTypeId(
            ContextEntitiesEnum.CurrentProjectTypeId,
            projectTypeId,
          );
          await dataContext.refreshProject();
        } else {
          if (dataContext.project == null) return;
          await dataContext.setContextEntityTypeId(
            ContextEntitiesEnum.CurrentProjectTypeId,
            null,
          );
          await dataContext.refreshProject();
        }
      } catch (err) {
        // Silent — failing to sync is non-fatal; the user can switch manually.
        console.warn('[useSyncContextProject] failed to sync', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);
}
