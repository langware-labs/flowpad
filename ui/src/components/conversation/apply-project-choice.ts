import { dataManager, Project, Task, TypeId } from '@sdk';
import { ActionInfo } from '@sdk/models/ActionInfo';

/**
 * Stamp a chosen Project onto a Task's metadata so subsequent task-bound
 * actions (Start Claude Code, Approve & Execute, Open in Project) read the
 * right cwd. Idempotent — calling repeatedly with the same project just
 * rewrites the same fields.
 *
 * Returns true when the task was updated, false when the task entity could
 * not be loaded (in which case the project is still set in context, the
 * caller's responsibility to handle the missing task).
 */
export async function applyProjectToTask(taskId: string, project: Project): Promise<boolean> {
  if (!taskId) return false;
  try {
    const task = await dataManager
      .getByTypeId<Task>(new TypeId(Task.type, taskId))
      .catch(() => null);
    if (!task) return false;
    task.metadata = {
      ...(task.metadata ?? {}),
      project_id: project.id,
      project_name: project.name ?? '',
      project_root: project.fs_storage_mount_path ?? '',
    };
    await task.save();
    return true;
  } catch {
    return false;
  }
}

/**
 * Persist a remote→local project mapping in the per-machine mapping table
 * so that future messages tagged with the same `remote_project_id` auto-route
 * to the picked local project without re-prompting. No-op when either id
 * is missing.
 */
export async function persistRemoteToLocalMapping(
  remoteProjectId: string | null | undefined,
  localProjectId: string | null | undefined,
): Promise<void> {
  if (!remoteProjectId || !localProjectId) return;
  try {
    const action = new ActionInfo('set-project-mapping', null, null, 'POST');
    action.bodyParameters = { remote_project_id: remoteProjectId, local_project_id: localProjectId };
    await dataManager.callAction(action);
  } catch {
    // non-fatal — the user can re-pick later if it didn't stick.
  }
}
