import { ActionInfo, AgenticProcess, dataManager, fsStore, TypeId } from '@sdk';

export interface ProcessInputDir {
  abs_path: string;
  compute_node_id: string;
}

/**
 * Resolve an agentic process's input directory — the per-process folder that
 * attachments (pasted screenshots, dropped files) are uploaded into so the
 * agent can read them by absolute path. Resolved lazily at upload time, not on
 * mount, so surfaces don't fire a per-mount GET for a rarely-used feature.
 */
export async function resolveProcessInputDir(procId: string): Promise<ProcessInputDir | null> {
  const dir = await dataManager.callAction<null, ProcessInputDir>(
    new ActionInfo('input-dir', AgenticProcess.type, procId, 'GET'),
  );
  if (!dir?.abs_path || !dir?.compute_node_id) return null;
  return dir;
}

/**
 * Upload files into the process's input dir and return one prompt reference
 * line per file (`File <name> is available here: <abs path>`). This is the
 * shared attachment convention: files ride along on the next prompt as plain
 * text path references, not structured attachments.
 */
export async function uploadFilesToProcessInputDir(procId: string, files: File[]): Promise<string[]> {
  if (!files.length) return [];
  const dir = await resolveProcessInputDir(procId);
  if (!dir) return [];
  const uploads = await fsStore.getState().uploadFiles(new TypeId(dir.compute_node_id), dir.abs_path, files);
  await Promise.all(uploads.map((u) => u.waitForCompletion()));
  return files.map((file) => `File ${file.name} is available here: ${dir.abs_path}/${file.name}`);
}
