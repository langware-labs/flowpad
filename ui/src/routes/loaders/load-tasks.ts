/**
 * Tasks dock loader for /dock/tasks/<taskId>[/conversation/<convId>].
 *
 * Pure primitive `loadTask(id)`:
 *   - Cache-first fetch of the Task entity.
 *   - Sets `dataContext`:
 *       - CurrentProjectTypeId  — from task.project_id (or null when unmapped)
 *       - CurrentActiveEntityTypeId — to the task itself
 *       - workdir              — from task.metadata.project_root when known
 *   - Prefetches the Project entity into the cache so the footer label /
 *     `useEntity(Project, …)` reads are warm on first paint.
 *
 * Wrapper `loadTasksRoute(pointer)` parses the URL pointer (which can
 * optionally include a `conversation/<convId>` tail), calls `loadTask`, and
 * — when a conversation segment is present — defers to `loadConversation`
 * to warm-load the conversation + parent task. The task stays the active
 * entity for this URL family (mirrors load-project.ts: the route's own
 * entity wins over the embedded one).
 */

import {
  ContextEntitiesEnum,
  dataContext,
  dataManager,
  Project,
  Task,
  TypeId,
} from '@sdk';
import { toast } from '@src/hooks/use-toast';
import { redirect } from 'react-router';
import { loadConversation } from './load-conversation';

export class TaskLoadError extends Error {
  constructor(
    readonly kind: 'not_found',
    readonly taskId: string,
  ) {
    super(`task-load:${kind}`);
  }
}

/**
 * Pure primitive — fetch the Task and set dataContext bits the page needs.
 * Throws `TaskLoadError` on a hard failure. Best-effort for the Project
 * prefetch (a missing project doesn't fail the task load — the footer just
 * shows the red "Select Project" pill until the user picks).
 */
export async function loadTask(taskId: string): Promise<Task> {
  const task = await dataManager
    .getByTypeId<Task>(new TypeId(Task.type, taskId))
    .catch(() => null);
  if (!task) {
    throw new TaskLoadError('not_found', taskId);
  }

  const taskMeta = (task.metadata as Record<string, unknown> | undefined) ?? {};
  const projectId = task.project_id ?? undefined;
  const projectRoot = taskMeta.project_root as string | undefined;

  // Active entity = the task. Mirrors how load-project sets the project as
  // the active entity for /dock/project/<id> and load-conversation sets the
  // conversation for /dock/conversation/<id>.
  await dataContext.setActiveEntityTypeId(new TypeId(Task.type, taskId));

  if (projectId) {
    await dataContext.setContextEntityTypeId(
      ContextEntitiesEnum.CurrentProjectTypeId,
      new TypeId(Project.type, projectId),
    );
    // Warm the cache so any `useEntity(Project, …)` consumer hits immediately.
    await dataManager
      .getByTypeId<Project>(new TypeId(Project.type, projectId))
      .catch(() => null);
  } else {
    // Task has no mapped project (receiver pre-mapping). Drop the global
    // active project to null — the StatusBar will render the red
    // "Select Project" pill. The mapping gate pops the picker when the user
    // takes an action that needs cwd (Open Claude Code, Approve & Execute).
    await dataContext.setContextEntityTypeId(
      ContextEntitiesEnum.CurrentProjectTypeId,
      null,
    );
  }

  if (projectRoot) {
    dataContext.setWorkdir(projectRoot);
  }

  return task;
}

/**
 * Route-level loader for /dock/tasks/<taskId>[/conversation/<convId>]. Owns
 * redirect policy. Delegates to `loadTask` and `loadConversation`.
 */
export async function loadTasksRoute(pointer: string | undefined): Promise<void> {
  if (!pointer) {
    // No task id — page renders its empty state ("Pick a task"). Nothing to load.
    return;
  }

  // Pointer shapes:
  //   <taskId>
  //   <taskId>/conversation/<convId>
  const parts = pointer.split('/').filter(Boolean);
  const taskId = parts[0] ?? '';
  const conversationId =
    parts.length >= 3 && parts[1] === 'conversation' ? parts[2] : null;
  if (!taskId) return;

  try {
    await loadTask(taskId);
  } catch (e) {
    if (!(e instanceof TaskLoadError)) throw e;
    toast({
      title: 'Task not found',
      description: 'This task no longer exists.',
      variant: 'destructive',
    });
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect('/dock/tasks');
  }

  // /dock/tasks/<taskId>/conversation/<convId> — warm-load the conversation
  // too, then restore the task as the active entity (since the task is what
  // owns this URL).
  if (conversationId) {
    try {
      await loadConversation(conversationId);
    } catch {
      // Soft-fail: page renders its own "Loading conversation…" state.
    }
    await dataContext.setActiveEntityTypeId(new TypeId(Task.type, taskId));
  }
}
