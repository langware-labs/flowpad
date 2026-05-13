/**
 * AgentTranscript — typed view of an agent's transcript.
 *
 * Mirrors flow_sdk/transcript_analyzer/transcript.py — but with no parsing
 * logic (the JSONL is parsed server-side; this class hydrates the REST
 * response shape).
 */

import { EntryKind, TranscriptEntry } from './entry';
import { ToolUseEntry } from './entries/tool_use';

export enum TranscriptFormat {
  CLAUDE_JSONL = 'claude_jsonl',
  CODEX_STREAM = 'codex_stream',
  CODEX_ROLLOUT = 'codex_rollout',
}

export enum TranscriptSource {
  PROCESS_LOCAL = 'process_local',
  WORKER_SESSION = 'worker_session',
}

export class AgentTranscript {
  worker_type: string;
  entries: TranscriptEntry[];
  session_id: string;
  path: string;
  transcript_format: TranscriptFormat | null;
  transcript_source: TranscriptSource | null;

  constructor(
    worker_type: string,
    entries: TranscriptEntry[] = [],
    session_id = '',
    options: {
      path?: string;
      transcript_format?: TranscriptFormat | null;
      transcript_source?: TranscriptSource | null;
    } = {},
  ) {
    this.worker_type = worker_type;
    this.entries = entries;
    this.session_id = session_id;
    this.path = options.path ?? '';
    this.transcript_format = options.transcript_format ?? null;
    this.transcript_source = options.transcript_source ?? null;
  }

  /** Yield entries matching all provided filters (AND-combined). */
  *filter(opts: { kind?: EntryKind; tool_name?: string }): Generator<TranscriptEntry> {
    for (const e of this.entries) {
      if (opts.kind !== undefined && e.kind !== opts.kind) continue;
      if (opts.tool_name !== undefined) {
        if (!(e instanceof ToolUseEntry)) continue;
        if (e.tool_name !== opts.tool_name) continue;
      }
      yield e;
    }
  }

  /** Most recent ToolUseEntry whose tool_name matches, or null. */
  latest_tool_use(tool_name: string): ToolUseEntry | null {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e instanceof ToolUseEntry && e.tool_name === tool_name) {
        return e;
      }
    }
    return null;
  }
}
