import { AgenticProcess, ProcessKind, TypeId, type Conversation } from '@sdk';

/** The sidecar on a conversation's context entry that marks a process as THE conversation's session — one
 *  launched from it, or one that wrote into it (`flow conversation send/new`). Mirrors Python `SESSION_ROLE`.
 *  A session shared as a message attachment is linked onto the conversation too, without it. */
export const SESSION_ROLE = { role: 'session' } as const;

/** Whether the conversation marks this linked process as its session. */
export function hasSessionRole(conversation: Pick<Conversation, 'getContextEntryData'>, processId: string): boolean {
  return conversation.getContextEntryData(new TypeId(AgenticProcess.type, processId))?.role === SESSION_ROLE.role;
}

/** The conversation's own sessions, as opposed to sessions merely shared into it: launched with the
 *  Conversation kind (sessions from before the marker), or marked by the link. */
export function isConversationSession(
  conversation: Pick<Conversation, 'getContextEntryData'>,
  process: Pick<AgenticProcess, 'id' | 'process_type'>,
): boolean {
  return process.process_type === ProcessKind.Conversation || hasSessionRole(conversation, process.id);
}

/** The sidecar that marks a linked process as a message's plan-implementation session (Implement Plan), with
 *  the message it implements. Mirrors Python `PLAN_ROLE`. Written when the session starts, so the conversation
 *  answers "does this thread have a plan session" from its own context — never from a scan of every process. */
export const PLAN_ROLE = { role: 'plan' } as const;

/** The conversation's plan sessions: process id → the message it implements. */
export function planSessionEntries(
  conversation: Pick<Conversation, 'getContextEntryData' | 'contextOfType'>,
): { processId: string; messageId: string }[] {
  return conversation.contextOfType(AgenticProcess.type, 'shared').flatMap((tid) => {
    const data = conversation.getContextEntryData(tid);
    return data?.role === PLAN_ROLE.role && typeof data.message_id === 'string'
      ? [{ processId: String(tid.id), messageId: data.message_id }]
      : [];
  });
}
