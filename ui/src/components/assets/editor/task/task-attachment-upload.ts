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
 * name) are skipped, and so is the same File picked twice. Two DIFFERENT
 * files that share a name (two pasted "image.png") are two files: the later one
 * is stored under the next free name ("image-2.png") rather than dropped — not
 * "image (2).png": the hub refuses `(` `)` in a file path, so it would never
 * travel. Returns only the newly added entries; a failed upload is reported
 * through `onError` and left out.
 */
export async function uploadFilesToTask(
  taskTypeId: TypeId,
  files: File[],
  existing: Attachment[] = [],
  onError?: (file: File, error: unknown) => void,
): Promise<Attachment[]> {
  const attached = new Set(existing.map(attachmentKey));
  const taken = new Set(attached);
  const added: Attachment[] = [];
  // A Set: the same File picked twice is one file. A name already attached is skipped; a
  // name taken earlier in THIS call is a different file and gets the next free name.
  for (const picked of new Set(files)) {
    if (!picked.name || attached.has(`${TASK_ATTACHMENTS_DIR}/${picked.name}`)) continue;
    const name = freeName(picked.name, (n) => taken.has(`${TASK_ATTACHMENTS_DIR}/${n}`));
    const file = name === picked.name ? picked : new File([picked], name, { type: picked.type });
    const vfs = `${TASK_ATTACHMENTS_DIR}/${name}`;
    try {
      await fsManager.uploadFile(taskTypeId, `/${TASK_ATTACHMENTS_DIR}`, file);
    } catch (e) {
      onError?.(picked, e);
      continue;
    }
    taken.add(vfs);
    added.push({ vfs, label: name });
  }
  return added;
}

/** `name`, or the first of "stem-2.ext", "stem-3.ext", … that is not `taken`. */
function freeName(name: string, taken: (name: string) => boolean): string {
  if (!taken(name)) return name;
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!taken(candidate)) return candidate;
  }
}
