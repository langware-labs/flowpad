/**
 * Worker-agnostic transcript entry types.
 *
 * Mirrors the Python `flow_sdk/transcript_analyzer/entries/*.py` types.
 * The server's `/api/v1/transcripts/{worker_type}` endpoint returns
 * `entry.to_dict()` per entry, and these types describe the JSON shape.
 *
 * Discriminated by the `kind` field. Use the `is*` guards in this file or
 * a `switch (entry.kind)` block to narrow types.
 */

import type { TranscriptFormat, TranscriptSource } from '../../transcript-analyzer';

export type EntryKind =
  | 'user_message'
  | 'assistant_message'
  | 'tool_use'
  | 'tool_result'
  | 'system'
  | 'summary'
  | 'meta'
  | 'token_usage'
  | 'unknown';

/** Common envelope fields shared across every entry. */
export interface BaseEntry {
  kind: EntryKind;
  id: string;
  session_id: string;
  timestamp: string;
  worker: string;
  parent_id: string | null;
  is_sidechain: boolean;
  /** Worker-side stable id (codex `response_item.id`, claude `message.id`). */
  entry_id: string | null;
  /** Model name (claude `message.model`, codex `turn_context.model`). */
  model: string | null;
}

export interface UserMessageEntry extends BaseEntry {
  kind: 'user_message';
  text: string;
  role: string; // "user" by default; non-user roles route to SystemEntry upstream
}

export interface AssistantMessageEntry extends BaseEntry {
  kind: 'assistant_message';
  text: string;
  thinking: string | null;
  /** Codex-only: `final_answer` | `commentary`. Null for claude. */
  phase: string | null;
}

export interface ToolUseEntry extends BaseEntry {
  kind: 'tool_use';
  tool_name: string;
  tool_use_id: string;
  /** Decoded JSON arguments object (string args are JSON-decoded server-side). */
  tool_input: Record<string, unknown>;
}

export interface ToolResultEntry extends BaseEntry {
  kind: 'tool_result';
  tool_use_id: string;
  tool_output: string;
  is_error: boolean;
  file_path: string | null;
  /** Cross-referenced from the matching ToolUse via `call_id`. May be null. */
  tool_name: string | null;
  /** Wall time of the tool execution in milliseconds (when known). */
  duration_ms: number | null;
  /** Process exit code (when applicable). */
  exit_code: number | null;
  /** Codex-only: ``Original token count`` from the output preamble. */
  output_token_count: number | null;
}

export interface SystemEntry extends BaseEntry {
  kind: 'system';
  subtype: string;
  payload: Record<string, unknown>;
}

export interface SummaryEntry extends BaseEntry {
  kind: 'summary';
  summary_text: string;
}

export interface MetaEntry extends BaseEntry {
  kind: 'meta';
  meta_kind: string;
  payload: Record<string, unknown>;
}

export interface TokenUsageEntry extends BaseEntry {
  kind: 'token_usage';
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  reasoning_output_tokens: number | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  turn_id: string | null;
}

export interface UnknownEntry extends BaseEntry {
  kind: 'unknown';
  raw_data: Record<string, unknown>;
}

export type GenericEntry =
  | UserMessageEntry
  | AssistantMessageEntry
  | ToolUseEntry
  | ToolResultEntry
  | SystemEntry
  | SummaryEntry
  | MetaEntry
  | TokenUsageEntry
  | UnknownEntry;

// ── Type guards ─────────────────────────────────────────────────────────────

export const isUserMessage = (e: GenericEntry): e is UserMessageEntry => e.kind === 'user_message';
export const isAssistantMessage = (e: GenericEntry): e is AssistantMessageEntry => e.kind === 'assistant_message';
export const isToolUse = (e: GenericEntry): e is ToolUseEntry => e.kind === 'tool_use';
export const isToolResult = (e: GenericEntry): e is ToolResultEntry => e.kind === 'tool_result';
export const isSystem = (e: GenericEntry): e is SystemEntry => e.kind === 'system';
export const isSummary = (e: GenericEntry): e is SummaryEntry => e.kind === 'summary';
export const isMeta = (e: GenericEntry): e is MetaEntry => e.kind === 'meta';
export const isTokenUsage = (e: GenericEntry): e is TokenUsageEntry => e.kind === 'token_usage';
export const isUnknown = (e: GenericEntry): e is UnknownEntry => e.kind === 'unknown';

// ── Header / response shape ─────────────────────────────────────────────────

export interface TranscriptHeader {
  cwd?: string;
  cli_version?: string;
  originator?: string;
  model_provider?: string;
  git?: {
    branch?: string;
    commit_hash?: string;
    repository_url?: string;
  };
}

export interface ParsedTranscript {
  worker_type: string;
  session_id: string;
  path: string;
  transcript_format: TranscriptFormat | null;
  transcript_source: TranscriptSource | null;
  header: TranscriptHeader;
  entries: GenericEntry[];
}
