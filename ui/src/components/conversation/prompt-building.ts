import { Conversation, dataManager, FlowMessage, TypeId } from '@sdk';

/** Title-case the type slug for human-friendly type labels. */
function humanType(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1).replace(/_/g, ' ');
}

/** How a worker reads a conversation: its record folder holds only pointers
 *  (the message text lives in the DB row), so the reference is a command. */
function conversationReadCommand(tid: TypeId): string {
  return `flow conversation show ${tid.toUrlString()} --last 30`;
}

/**
 * Build the "context entities saved locally" lines for a list of TypeIds.
 *
 * Most Flowpad entities are mirrored on disk under `recordsRoot` as the folder
 * `<type>/<id>/` (metadata.json, the asset). Conversations and messages are
 * not: their folders hold pointers only, so a conversation line names the
 * `flow conversation show` command instead, and messages are skipped (they
 * are read through their conversation). When `recordsRoot` is unset (hub /
 * remote runtime) the TypeId alone is the reference.
 *
 * Format per line: `- <TypeName>: <type>/<id>, read: <folder-path | command>`.
 * Caller is expected to dedupe TypeIds before passing them in.
 */
export function buildContextEntityLines(typeIds: readonly TypeId[]): string[] {
  const recordsRoot = dataManager.recordsRoot;
  const out: string[] = [];
  for (const tid of typeIds) {
    if (!tid?.type || !tid?.id || tid.type === FlowMessage.type) continue;
    const label = humanType(tid.type);
    if (tid.type === Conversation.type) {
      out.push(`- ${label}: ${tid.toUrlString()}, read: \`${conversationReadCommand(tid)}\``);
    } else if (recordsRoot) {
      const recordPath = `${recordsRoot}/${tid.type}/${tid.id}`;
      out.push(`- ${label}: ${tid.toUrlString()}, read: ${recordPath}`);
    } else {
      // No records root known (hub / remote runtime): the TypeId alone is the
      // reference. Workers resolve it through their pinned FLOW_INSTANCE backend
      // (`flow` verbs / MCP), never through a URL baked into the prompt.
      out.push(`- ${label}: ${tid.toUrlString()}`);
    }
  }
  return out;
}

/**
 * Format the conversation's context as two labelled groups — "Shared" (what
 * every participant can see on the message) and "Private" (what the local
 * user has attached for themselves under Private Context).
 *
 * Returned as a single newline-joined block; empty groups are skipped so a
 * conversation with no private items doesn't emit a dangling header.
 */
export function buildSharedAndPrivateContextSection(
  sharedTypeIds: readonly TypeId[],
  privateTypeIds: readonly TypeId[],
): string {
  const parts: string[] = [];
  const sharedLines = buildContextEntityLines(sharedTypeIds);
  if (sharedLines.length > 0) {
    parts.push('Shared context (visible to every participant in this conversation):');
    parts.push(...sharedLines);
  }
  const privateLines = buildContextEntityLines(privateTypeIds);
  if (privateLines.length > 0) {
    if (parts.length > 0) parts.push('');
    parts.push('Private context (visible only to you):');
    parts.push(...privateLines);
  }
  return parts.join('\n');
}

/**
 * Build the instruction injected when the user clicks "Use Flowpad assistance"
 * below the Private Context table. The session has no concrete task yet — it
 * just exposes the available shared/private entities so Claude can answer
 * questions from any participant.
 */
export function buildAssistancePrompt(sharedTypeIds: readonly TypeId[], privateTypeIds: readonly TypeId[]): string {
  const ctx = buildSharedAndPrivateContextSection(sharedTypeIds, privateTypeIds);
  const intro =
    'Use Flowpad Assistant to help answer questions from the user. ' +
    'Read each referenced entity folder to ground your answers in the actual entity contents.';
  return ctx ? `${intro}\n\n${ctx}` : intro;
}

/**
 * Build the instruction injected when the user launches a worker from the
 * conversation header: the session starts by catching up on the conversation
 * itself, so its first answer is where the conversation stands now.
 */
export function buildConversationStatusPrompt(conversationTypeId: TypeId): string {
  return (
    `Use Flowpad Assistant to read the Flowpad conversation ${conversationTypeId.toUrlString()} ` +
    'and report its latest status: what was discussed most recently, what is still open, and who is waiting on whom.\n\n' +
    `Read it with \`${conversationReadCommand(conversationTypeId)}\` (full messages, oldest first; ` +
    'drop --last to read all of it). Open one message and its attachments with ' +
    '`flow conversation message <message-id>`.'
  );
}

/**
 * Build the instruction injected when the user launches a worker from one
 * message's ⋮ menu: the session starts AT that message — it reads the message
 * (and its attachments) first, and the conversation only as background.
 */
export function buildMessageStartPrompt(conversationTypeId: TypeId, messageTypeId: TypeId): string {
  return (
    `Use Flowpad Assistant to start from message ${messageTypeId.toUrlString()} in the Flowpad conversation ` +
    `${conversationTypeId.toUrlString()} — that message is what this session is about.\n\n` +
    `Read it first, in full with its attachments: \`flow conversation message ${messageTypeId.toUrlString()}\`. ` +
    `For background only, read what led up to it with \`${conversationReadCommand(conversationTypeId)}\`. ` +
    'Then say in a few lines what the message asks for and what you need to act on it.'
  );
}

/** The live session the launching user is the GUEST of in this conversation, for the launch prompt. */
export interface LiveSessionNote {
  hostName: string;
  sessionId: string;
  /** The kinds of turn the host approved; null while the session still awaits approval. */
  approvedKinds: readonly string[] | null;
}

const TURN_KIND_WORDS: Record<string, string> = { prompt: 'prompts', command: 'commands', control: 'Flowpad control' };

/**
 * A launch prompt, plus one line when the user has a live session open on the other person's
 * machine: the worker is told it exists, what it may run there, and which skill covers it.
 */
export function withLiveSessionNote(prompt: string, note: LiveSessionNote | null | undefined): string {
  if (!note) return prompt;
  const id = note.sessionId.slice(0, 8);
  if (!note.approvedKinds) {
    return (
      `${prompt}\n\nNote: a live session with ${note.hostName} is awaiting approval (session ${id}). ` +
      'Use the `live-session-helper` skill once it is approved.'
    );
  }
  const kinds = note.approvedKinds.map((k) => TURN_KIND_WORDS[k] ?? k).join(', ');
  return (
    `${prompt}\n\nNote: a live session with ${note.hostName} is active (session ${id}, approved: ${kinds}). ` +
    'Use the `live-session-helper` skill to work through it.'
  );
}
