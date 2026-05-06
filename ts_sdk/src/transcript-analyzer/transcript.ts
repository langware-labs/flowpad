/**
 * AgentTranscript — typed view of an agent's transcript.
 *
 * Mirrors flow_sdk/transcript_analyzer/transcript.py — but with no parsing
 * logic (the JSONL is parsed server-side; this class hydrates the REST
 * response shape).
 */

import { EntryKind, TranscriptEntry } from './entry';
import { ToolUseEntry } from './entries/tool_use';

export class AgentTranscript {
  worker_type: string;
  entries: TranscriptEntry[];
  session_id: string;

  constructor(worker_type: string, entries: TranscriptEntry[] = [], session_id = '') {
    this.worker_type = worker_type;
    this.entries = entries;
    this.session_id = session_id;
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
