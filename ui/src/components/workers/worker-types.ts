import { CapabilityKinds } from '@sdk';

/**
 * The CLI worker vendors launchable from any UI surface — the shared
 * `WorkerToolbar`, conversation controls, Vibe selectors, project pickers, and
 * the last-opener hook all agree on this one list and type. Lives in `workers/`
 * because it is cross-cutting; `conversation-session-constants` re-exports it
 * for back-compat.
 */
export type WorkerType = 'claude_code' | 'codex' | 'copilot' | 'opencode';

export const LAUNCHABLE_WORKERS: WorkerType[] = ['claude_code', 'codex', 'copilot', 'opencode'];

/**
 * Vendor → its own harness capability kind.
 *
 * Gating on the vendor's OWN row means a missing binary is reported against the
 * vendor the user actually clicked, not against whatever the generic `harness`
 * default resolves to. This lives beside `LAUNCHABLE_WORKERS` because the same
 * association was previously spelled three separate times in the terminal strip
 * alone (a ternary ladder, the opener literals, and the capabilities context) —
 * one table, so a new vendor is one row.
 */
export const HARNESS_CAPABILITY_BY_WORKER: Record<WorkerType, string> = {
  claude_code: CapabilityKinds.ClaudeCode,
  codex: CapabilityKinds.Codex,
  copilot: CapabilityKinds.Copilot,
  opencode: CapabilityKinds.OpenCode,
};
/** Presentation-only fallback before capability bootstrap data is available.
 * Runtime process defaults are resolved by the backend `harness` capability. */
export const FALLBACK_WORKER_TYPE: WorkerType = LAUNCHABLE_WORKERS[0];

export function normalizeWorkerType(value: string | null | undefined): WorkerType {
  const worker = value?.toLowerCase();
  if (worker === 'claude' || worker === 'claude_code') return 'claude_code';
  if (worker === 'codex') return 'codex';
  if (worker === 'copilot') return 'copilot';
  if (worker === 'opencode') return 'opencode';
  return FALLBACK_WORKER_TYPE;
}
