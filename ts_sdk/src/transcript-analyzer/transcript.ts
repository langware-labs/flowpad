/**
 * AgentTranscriptFile — typed view of an agent's transcript.
 *
 * Mirrors flow_sdk/transcript_analyzer/transcript.py — but with no parsing
 * logic (the JSONL is parsed server-side; this class hydrates the REST
 * response shape).
 */

import { AssistantMessageEntry } from './entries/assistant_message';
import { ToolUseEntry } from './entries/tool_use';
import { UserMessageEntry } from './entries/user_message';
import { EntryKind, TranscriptEntry } from './entry';

/**
 * Synthetic user-message texts the agent injects (not real prompts) — dropped
 * from prompt lists and clean-chat renders. Mirrors `_SYNTHETIC_USER_TEXTS` in
 * flow_sdk/transcript_analyzer/transcript.py.
 */
export const SYNTHETIC_USER_TEXTS = new Set(['[Request interrupted by user for tool use]']);

export enum TranscriptFormat {
  CLAUDE_JSONL = 'claude_jsonl',
  CODEX_STREAM = 'codex_stream',
  CODEX_ROLLOUT = 'codex_rollout',
  COPILOT_STREAM = 'copilot_stream',
  COPILOT_EVENTS = 'copilot_events',
  // FlowPad owns both opencode formats: the headless stdout tee, and the
  // projection assembled from opencode's SQLite store for PTY sessions.
  OPENCODE_STREAM = 'opencode_stream',
  OPENCODE_SESSION = 'opencode_session',
}

export enum TranscriptSource {
  PROCESS_LOCAL = 'process_local',
  WORKER_SESSION = 'worker_session',
}

export class AgentTranscriptFile {
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

  /**
   * Render the transcript as a clean, text-friendly chat — suitable for
   * pasting into a doc or issue.
   *
   * Unlike the Python `to_string()` (a verbose debug dump with entry banners,
   * ids, and timestamps), this collapses the transcript to readable turns:
   * `## You` / `## Assistant` headings with the message text, and tool calls
   * folded to a single `→ tool  arg` line under the assistant turn. Sub-agent
   * (sidechain) lines, tool results, reasoning, and control-plane entries are
   * dropped. Blocks are separated by a blank line.
   */
  toText(): string {
    const blocks: string[] = [`# Chat — ${this.worker_type || 'agent'}`];
    // 'you' | 'assistant' — heading is only re-emitted when the role changes,
    // so an assistant message and its following tool calls share one heading.
    let lastRole: 'you' | 'assistant' | null = null;

    const pushTurn = (role: 'you' | 'assistant', body: string) => {
      if (role !== lastRole) {
        blocks.push(role === 'you' ? '## You' : '## Assistant');
        lastRole = role;
      }
      blocks.push(body);
    };

    for (const e of this.entries) {
      if (e.is_sidechain) continue;

      if (e instanceof UserMessageEntry) {
        const text = e.text.trim();
        if (!text || SYNTHETIC_USER_TEXTS.has(text)) continue;
        pushTurn('you', text);
      } else if (e instanceof AssistantMessageEntry) {
        const text = e.text.trim();
        if (!text) continue;
        pushTurn('assistant', text);
      } else if (e instanceof ToolUseEntry) {
        const arg = AgentTranscriptFile.primaryToolArg(e.tool_input);
        pushTurn('assistant', arg ? `→ ${e.tool_name}  ${arg}` : `→ ${e.tool_name}`);
      }
      // tool_result / system / summary / meta / token_usage / unknown: dropped.
    }

    return blocks.join('\n\n');
  }

  /** First informative tool-input field, collapsed to a single line. */
  private static primaryToolArg(input: Record<string, unknown>): string {
    for (const key of ['file_path', 'path', 'command', 'pattern', 'url', 'query']) {
      const v = input[key];
      if (typeof v !== 'string') continue;
      const trimmed = v.trim();
      if (trimmed) return trimmed.split('\n', 1)[0].slice(0, 120);
    }
    return '';
  }
}
