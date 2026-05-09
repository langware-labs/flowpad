import { Conversation, dataManager, Project, Task, TypeId } from '@sdk';
import { writeProjectMapping } from './useProjectMapping';

export interface ApplyProjectResult {
  /** True when at least one entity was actually written. */
  saved: boolean;
  /** True when the conversation already had a *different* `project_id` and we
   *  replaced it. Drives the "navigate to the new project's home" UX after a
   *  remap (Feature 1). */
  wasReplacement: boolean;
}

/**
 * Stamp a chosen Project onto a Task and its Conversation. Idempotent —
 * calling repeatedly with the same project just rewrites the same fields.
 *
 * Writes:
 *   - `task.project_id` (FK)
 *   - `task.project_name` / `task.project_root` (annotations)
 *   - `conversation.project_id` (top-level on Conversation)
 *
 * Returns `wasReplacement=true` when the conversation already had a different
 * project — the caller can use this to navigate to the new project's home.
 */
export async function applyProjectToTask(taskId: string, project: Project): Promise<ApplyProjectResult> {
  if (!taskId) return { saved: false, wasReplacement: false };
  try {
    const task = await dataManager
      .getByTypeId<Task>(new TypeId(Task.type, taskId))
      .catch(() => null);
    if (!task) return { saved: false, wasReplacement: false };
    const newId = project.id ?? null;
    let saved = false;
    if (task.project_id !== newId) { task.project_id = newId; saved = true; }
    const newName = project.name ?? '';
    if ((task.project_name ?? '') !== newName) { task.project_name = newName; saved = true; }
    const newRoot = project.fs_storage_mount_path ?? '';
    if ((task.project_root ?? '') !== newRoot) { task.project_root = newRoot; saved = true; }
    if (saved) await task.save();

    // Mirror onto the bound conversation so the conv-side fields (used by the
    // page loader and the gate) stay in sync.
    let wasReplacement = false;
    const convTypeId = task.firstContextOfType('conversation');
    if (convTypeId) {
      const r = await applyProjectToConversation(convTypeId.id, project);
      saved = saved || r.saved;
      wasReplacement = r.wasReplacement;
    }
    return { saved, wasReplacement };
  } catch {
    return { saved: false, wasReplacement: false };
  }
}

/**
 * Stamp a chosen Project onto a Conversation. Used for task-less conversations
 * (project-scoped or hub-direct chats) where there's no task to anchor the
 * mapping. Sets `conversation.project_id`. Idempotent. Returns
 * `wasReplacement=true` when the conversation previously pointed at a
 * different project.
 */
export async function applyProjectToConversation(
  conversationId: string,
  project: Project,
): Promise<ApplyProjectResult> {
  if (!conversationId) return { saved: false, wasReplacement: false };
  try {
    const conv = await dataManager
      .getByTypeId<Conversation>(new TypeId(Conversation.type, conversationId))
      .catch(() => null);
    if (!conv) return { saved: false, wasReplacement: false };
    const previous = conv.project_id ?? null;
    const next = project.id ?? null;
    if (previous === next) return { saved: false, wasReplacement: false };
    const wasReplacement = !!previous && !!next;
    conv.project_id = next;
    await conv.save();
    return { saved: true, wasReplacement };
  } catch {
    return { saved: false, wasReplacement: false };
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
