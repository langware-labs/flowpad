/**
 * Base TranscriptEntry and EntryKind enum.
 *
 * Mirrors flow_sdk/transcript_analyzer/entry.py.
 *
 * The class hierarchy under entries/ is the canonical type discriminator —
 * EntryKind is a tag exposed for ergonomic filtering on
 * AgentTranscriptFile.filter({kind: ...}).
 */

export enum EntryKind {
  USER_MESSAGE = 'user_message',
  ASSISTANT_MESSAGE = 'assistant_message',
  TOOL_USE = 'tool_use',
  TOOL_RESULT = 'tool_result',
  AGENT_SPAWN = 'agent_spawn',
  SYSTEM = 'system',
  SUMMARY = 'summary',
  META = 'meta',
  TOKEN_USAGE = 'token_usage',
  UNKNOWN = 'unknown',
}

export interface TranscriptEntryBase {
  id: string;
  session_id: string;
  timestamp: string;
  worker: string;
  parent_id?: string | null;
  is_sidechain?: boolean;
  raw_data?: Record<string, unknown> | null;
  entry_id?: string | null;
  model?: string | null;
}

/**
 * A single line parsed from an agent's transcript JSONL.
 *
 * Subclasses live under entries/ and override `kind`. The base class only
 * carries the envelope fields common to every entry, regardless of worker.
 */
export class TranscriptEntry {
  kind: EntryKind = EntryKind.UNKNOWN;

  id: string;
  session_id: string;
  timestamp: string;
  worker: string;
  parent_id: string | null;
  is_sidechain: boolean;
  raw_data: Record<string, unknown> | null;
  entry_id: string | null;
  model: string | null;

  constructor(base: TranscriptEntryBase) {
    this.id = base.id;
    this.session_id = base.session_id;
    this.timestamp = base.timestamp;
    this.worker = base.worker;
    this.parent_id = base.parent_id ?? null;
    this.is_sidechain = base.is_sidechain ?? false;
    this.raw_data = base.raw_data ?? null;
    this.entry_id = base.entry_id ?? null;
    this.model = base.model ?? null;
  }
}
