import { ActionInfo, AgenticProcess, dataManager, fsStore, TypeId } from '@sdk';

export interface ProcessInputDir {
  abs_path: string;
  compute_node_id: string;
}

// The input dir is immutable for a given process id, so resolve it once and
// share the in-flight promise across concurrent callers. Failed resolutions
// are evicted so the next attempt retries.
const inputDirCache = new Map<string, Promise<ProcessInputDir | null>>();

/**
 * Resolve an agentic process's input directory — the per-process folder that
 * attachments (pasted screenshots, dropped files) are uploaded into so the
 * agent can read them by absolute path. Resolved lazily at upload time, not on
 * mount, so surfaces don't fire a per-mount GET for a rarely-used feature.
 */
export async function resolveProcessInputDir(procId: string): Promise<ProcessInputDir | null> {
  const cached = inputDirCache.get(procId);
  if (cached) return cached;
  const pending = (async () => {
    const dir = await dataManager.callAction<null, ProcessInputDir>(
      new ActionInfo('input-dir', AgenticProcess.type, procId, 'GET'),
    );
    if (!dir?.abs_path || !dir?.compute_node_id) return null;
    return dir;
  })();
  inputDirCache.set(procId, pending);
  pending.then(
    (dir) => { if (!dir) inputDirCache.delete(procId); },
    () => inputDirCache.delete(procId),
  );
  return pending;
}

/**
 * Upload files into the process's input dir and return one prompt reference
 * line per file (`File <name> is available here: <abs path>`). This is the
 * shared attachment convention: files ride along on the next prompt as plain
 * text path references, not structured attachments. Throws when the input dir
 * cannot be resolved — callers own the failure policy (abort vs degrade), and
 * a silent empty return would let them believe the files went along.
 */
export async function uploadFilesToProcessInputDir(procId: string, files: File[]): Promise<string[]> {
  if (!files.length) return [];
  const dir = await resolveProcessInputDir(procId);
  if (!dir) throw new Error('Could not resolve the process input directory');
  const uploads = await fsStore.getState().uploadFiles(new TypeId(dir.compute_node_id), dir.abs_path, files);
  await Promise.all(uploads.map((u) => u.waitForCompletion()));
  return files.map((file) => `File ${file.name} is available here: ${dir.abs_path}/${file.name}`);
}

/**
 * The one prompt-composition rule for attachments: upload `files` and append
 * the reference lines to `text` (which may be empty — a files-only prompt is
 * just the reference lines). Every surface that sends a prompt with attached
 * files goes through here so the agent sees a single prompt shape.
 */
export async function appendUploadedFileRefs(procId: string, text: string, files?: File[]): Promise<string> {
  if (!files?.length) return text;
  const refs = await uploadFilesToProcessInputDir(procId, files);
  return text ? `${text}\n\n${refs.join('\n')}` : refs.join('\n');
}
