/**
 * The CLI worker vendors launchable from any UI surface — the shared
 * `WorkerToolbar`, conversation controls, Vibe selectors, project pickers, and
 * the last-opener hook all agree on this one list and type. Lives in `workers/`
 * because it is cross-cutting; `conversation-session-constants` re-exports it
 * for back-compat.
 */
export type WorkerType = 'claude_code' | 'codex' | 'copilot';

export const LAUNCHABLE_WORKERS: WorkerType[] = ['claude_code', 'codex', 'copilot'];
/** Presentation-only fallback before capability bootstrap data is available.
 * Runtime process defaults are resolved by the backend `harness` capability. */
export const FALLBACK_WORKER_TYPE: WorkerType = LAUNCHABLE_WORKERS[0];

export function normalizeWorkerType(value: string | null | undefined): WorkerType {
  const worker = value?.toLowerCase();
  if (worker === 'claude' || worker === 'claude_code') return 'claude_code';
  if (worker === 'codex') return 'codex';
  if (worker === 'copilot') return 'copilot';
  return FALLBACK_WORKER_TYPE;
}
