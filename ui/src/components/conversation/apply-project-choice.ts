import { Conversation, dataManager, Project, Task, TypeId } from '@sdk';
import { writeProjectMapping } from './useProjectMapping';

/**
 * Stamp a chosen Project onto a Task and its Conversation. Idempotent —
 * calling repeatedly with the same project just rewrites the same fields.
 *
 * Writes:
 *   - `task.project_id`     (top-level, was `task.metadata.project_id`)
 *   - `task.metadata.project_name` / `project_root`  (annotations)
 *   - `conversation.project_id` (top-level on Conversation)
 *
 * Returns true when at least the task was updated.
 */
export async function applyProjectToTask(taskId: string, project: Project): Promise<boolean> {
  if (!taskId) return false;
  try {
    const task = await dataManager
      .getByTypeId<Task>(new TypeId(Task.type, taskId))
      .catch(() => null);
    if (!task) return false;
    task.project_id = project.id ?? null;
    task.metadata = {
      ...(task.metadata ?? {}),
      project_name: project.name ?? '',
      project_root: project.fs_storage_mount_path ?? '',
    };
    await task.save();

    // Also stamp the conversation when the task points at one. Keeps the
    // RecentConversationsStrip / project-scoped views in sync without
    // requiring a separate "set conversation project" step.
    if (task.conversation_id) {
      const conv = await dataManager
        .getByTypeId<Conversation>(new TypeId(Conversation.type, task.conversation_id))
        .catch(() => null);
      if (conv && conv.project_id !== project.id) {
        conv.project_id = project.id ?? null;
        await conv.save();
      }
    }
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
    await writeProjectMapping(remoteProjectId, localProjectId);
  } catch {
    // non-fatal — the user can re-pick later if it didn't stick.
  }
}
