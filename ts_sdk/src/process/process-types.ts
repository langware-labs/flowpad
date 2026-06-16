/**
 * Discriminates how an AgenticProcess is being used.
 *
 * - Chat: conversational process attached to an editor surface (chat about
 *   this doc; populated by the side-drawer Chat tab).
 * - Execution: process that executes an embedded asset (agent / skill) or
 *   runs a workflow / runs an asset on a doc.
 * - Analysis: child process that analyzes another process's worker session
 *   (agent-trace); paired with the analyzed process (parent + mutual private
 *   context).
 * - Conversation: the single live worker session that owns a Conversation; the
 *   conversation header's Open button targets it, and its absence is what
 *   surfaces the launch toolbar.
 */
export const ProcessKind = {
  Chat: 'chat',
  Execution: 'execution',
  Analysis: 'analysis',
  Conversation: 'conversation',
} as const;

export type ProcessKind = (typeof ProcessKind)[keyof typeof ProcessKind];

/** @deprecated Renamed to ProcessKind (2026-06-12). */
export const ProcessType = ProcessKind;
/** @deprecated Renamed to ProcessKind (2026-06-12). */
export type ProcessType = ProcessKind;
