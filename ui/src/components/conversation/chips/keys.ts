import type { ITask } from '@sdk/entities/task';
import type { ConversationTranscriptInfo } from '../find-conversation-transcript';

/**
 * Stable, deterministic chip identifiers. Each chip is keyed once so the
 * three chip rows (TaskChips / ConversationChips / MessageChips) can dedupe
 * across levels — a higher-level row tells lower-level rows what it already
 * rendered, and they skip those.
 *
 * Convention: `<kind>:<id>`. The `:<id>` keeps two chips of the same kind
 * separate when they refer to different entities.
 */

export const ChipKey = {
  project: (id?: string | null) => `project:${id ?? ''}`,
  task: (id?: string | null) => `task:${id ?? ''}`,
  spec: (id?: string | null) => `spec:${id ?? ''}`,
  process: (taskId?: string | null) => `process:${taskId ?? ''}`,
  transcript: (vfsPath?: string | null) => `transcript:${vfsPath ?? ''}`,
  sharedTerminal: (processId?: string | null) => `shared-terminal:${processId ?? ''}`,
  download: (messageId?: string | null) => `download:${messageId ?? ''}`,
} as const;

/** Chips that ``TaskChips`` would render given its inputs. */
export function taskChipKeys(task: ITask | null | undefined): Set<string> {
  const keys = new Set<string>();
  if (!task) return keys;
  if (task.project_id) keys.add(ChipKey.project(task.project_id));
  if (task.spec_id) keys.add(ChipKey.spec(task.spec_id));
  if (task.id) keys.add(ChipKey.process(task.id));
  return keys;
}

/** Chips that ``ConversationChips`` would render given its inputs. */
export function conversationChipKeys(args: {
  transcript?: ConversationTranscriptInfo | null;
  sharedTerminalId?: string | null;
}): Set<string> {
  const keys = new Set<string>();
  if (args.transcript) keys.add(ChipKey.transcript(args.transcript.vfsPath));
  if (args.sharedTerminalId) keys.add(ChipKey.sharedTerminal(args.sharedTerminalId));
  return keys;
}

/** Union of two key sets, returning a fresh ``Set``. */
export function unionKeys(a: Set<string>, b: Set<string>): Set<string> {
  const out = new Set(a);
  for (const k of b) out.add(k);
  return out;
}
