/**
 * Tasks dock loader for /dock/tasks/<taskId>[/conversation/<convId>].
 *
 * Pure primitive `loadTask(id)`:
 *   - Cache-first fetch of the Task entity.
 *   - Sets `dataContext`:
 *       - CurrentProjectTypeId  — from task.project_id (or null when unmapped)
 *       - CurrentActiveEntityTypeId — to the task itself
 *       - workdir              — from task.project_root when known
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

import { t } from '@lingui/core/macro';
import { ContextEntitiesEnum, dataContext, dataManager, Project, Task, TypeId } from '@sdk';
import { DockLoadError } from './dock-load-error';
import { loadConversation } from './load-conversation';

export class TaskLoadError extends Error {
  constructor(
    readonly kind: 'not_found' | 'network_error',
    readonly taskId: string,
    readonly cause?: unknown,
  ) {
    super(`task-load:${kind}`);
  }
}

function taskLoadStatus(error: unknown): number | undefined {
  return (
    (error as { response?: { status?: number }; status?: number } | null)?.response?.status ??
    (error as { status?: number } | null)?.status
  );
}

async function applyTaskContext(taskId: string, task: Task): Promise<void> {
  const projectId = task.project_id ?? undefined;
  const projectRoot = task.project_root ?? undefined;

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
    const project = await dataManager.getByTypeId<Project>(new TypeId(Project.type, projectId)).catch(() => null);
    dataContext.setWorkdir(projectRoot ?? project?.fs_storage_mount_path ?? null);
  } else {
    // Task has no mapped project (receiver pre-mapping). Drop the global
    // active project to null — the StatusBar will render the red
    // "Select Project" pill. The mapping gate pops the picker when the user
    // takes an action that needs cwd (Open Claude Code, Approve & Execute).
    await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, null);
    dataContext.setWorkdir(projectRoot ?? null);
  }
}

/**
 * Pure primitive — fetch the Task and set dataContext bits the page needs.
 * Throws `TaskLoadError` on a hard failure. Best-effort for the Project
 * prefetch (a missing project doesn't fail the task load — the footer just
 * shows the red "Select Project" pill until the user picks).
 */
export async function loadTask(taskId: string): Promise<Task> {
  let task: Task | null = null;
  try {
    task = await dataManager.getByTypeId<Task>(new TypeId(Task.type, taskId));
  } catch (cause) {
    const status = taskLoadStatus(cause);
    if (status === 404 || status === 403) {
      throw new TaskLoadError('not_found', taskId, cause);
    }
    throw new TaskLoadError('network_error', taskId, cause);
  }
  if (!task) {
    throw new TaskLoadError('not_found', taskId);
  }

  await applyTaskContext(taskId, task);

  return task;
}

/**
 * Route-level loader for /dock/tasks/<taskId>[/conversation/<convId>]. Owns
 * route error policy. Delegates to `loadTask` and `loadConversation`.
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
  const conversationId = parts.length >= 3 && parts[1] === 'conversation' ? parts[2] : null;
  if (!taskId) return;

  let task: Task;
  try {
    task = await loadTask(taskId);
  } catch (e) {
    if (!(e instanceof TaskLoadError)) throw e;
    if (e.kind === 'network_error') {
      throw new DockLoadError(
        'task_network_error',
        'soft',
        {
          action: 'render_error',
          title: t`Task unavailable`,
          message: t`Could not load this task. Try again in a moment.`,
          retryable: true,
        },
        'tasks',
        e,
      );
    }
    throw new DockLoadError(
      'task_not_found',
      'hard',
      {
        action: 'render_error',
        title: t`Task not found`,
        message: t`This task no longer exists or is unavailable.`,
      },
      'tasks',
      e,
    );
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
    await applyTaskContext(taskId, task);
  }
}
