/** The CLI harnesses a conversation session can launch — drives the worker
 *  buttons in the conversation header and the Private Context "+" menu. Glyph +
 *  label come from the shared worker-vendor helpers (transcript-utils) so they
 *  match every other surface. Shared here so the header component and the drawer
 *  agree on the exact list and type. */
export type WorkerType = 'claude_code' | 'codex' | 'copilot';

export const LAUNCHABLE_WORKERS: WorkerType[] = ['claude_code', 'codex', 'copilot'];
