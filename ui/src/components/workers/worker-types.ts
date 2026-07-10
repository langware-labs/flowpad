/**
 * The CLI worker vendors launchable from any UI surface — the shared
 * `WorkerToolbar`, the conversation header/drawer, the skill + discuss editors,
 * the projects picker, and the last-opener hook all agree on this one list and
 * type. Lives in `workers/` (not a single consumer's folder) because it's
 * cross-cutting; `conversation-session-constants` re-exports it for back-compat.
 */
export type WorkerType = 'claude_code' | 'codex' | 'copilot';

export const LAUNCHABLE_WORKERS: WorkerType[] = ['claude_code', 'codex', 'copilot'];
export const DEFAULT_WORKER_TYPE: WorkerType = LAUNCHABLE_WORKERS[0];

export function normalizeWorkerType(value: string | null | undefined): WorkerType {
  const worker = value?.toLowerCase();
  if (worker === 'claude' || worker === 'claude_code') return 'claude_code';
  if (worker === 'codex') return 'codex';
  if (worker === 'copilot') return 'copilot';
  return DEFAULT_WORKER_TYPE;
}
