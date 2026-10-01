import { fsManager, type TypeId } from '@sdk';
import { type Attachment, attachmentKey } from './task-attachments-utils';

/** Where a task keeps its attached files, inside its own folder
 *  (`agentic-assets/task/<name>/attachments/`). Being inside the folder is
 *  what makes them travel: a shared task's .flowmsg copies the folder as-is. */
export const TASK_ATTACHMENTS_DIR = 'attachments';

/**
 * Copy files onto a task — the one way bytes become a task attachment. Each
 * file is uploaded into the task's `attachments/` folder and comes back as a
 * `{vfs, label}` entry for `task.artifacts`. Files already attached (same
 * name) are skipped. Returns only the newly added entries; a failed upload is
 * reported through `onError` and left out.
 */
export async function uploadFilesToTask(
  taskTypeId: TypeId,
  files: File[],
  existing: Attachment[] = [],
  onError?: (file: File, error: unknown) => void,
): Promise<Attachment[]> {
  const keys = new Set(existing.map(attachmentKey));
  const added: Attachment[] = [];
  for (const file of files) {
    const vfs = `${TASK_ATTACHMENTS_DIR}/${file.name}`;
    if (!file.name || keys.has(vfs)) continue;
    try {
      await fsManager.uploadFile(taskTypeId, `/${TASK_ATTACHMENTS_DIR}`, file);
    } catch (e) {
      onError?.(file, e);
      continue;
    }
    keys.add(vfs);
    added.push({ vfs, label: file.name });
  }
  return added;
}
