/**
 * Discriminates how an AgenticProcess is being used.
 *
 * - Chat: conversational process attached to an editor surface (chat about
 *   this doc; populated by the side-drawer Chat tab).
 * - Execution: process that executes an embedded asset (agent / skill) or
 *   runs a workflow / runs an asset on a doc.
 */
export const ProcessType = {
  Chat: 'chat',
  Execution: 'execution',
} as const;

export type ProcessType = (typeof ProcessType)[keyof typeof ProcessType];
