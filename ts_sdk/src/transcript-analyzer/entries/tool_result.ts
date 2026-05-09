/** ToolResultEntry — a user line carrying a tool result. */

import { EntryKind, TranscriptEntry, type TranscriptEntryBase } from '../entry';

export interface ToolResultEntryData extends TranscriptEntryBase {
  tool_use_id: string;
  tool_output: string;
  is_error?: boolean;
  file_path?: string | null;
  tool_name?: string | null;
  duration_ms?: number | null;
  exit_code?: number | null;
  output_token_count?: number | null;
}

export class ToolResultEntry extends TranscriptEntry {
  override kind = EntryKind.TOOL_RESULT;

  tool_use_id: string;
  tool_output: string;
  is_error: boolean;
  file_path: string | null;
  /**
   * Set when known. Codex synthesizes "shell" for command_execution items;
   * Claude tool_results don't carry it inline so it's null until cross-
   * referenced with a preceding ToolUseEntry.
   */
  tool_name: string | null;
  duration_ms: number | null;
  exit_code: number | null;
  output_token_count: number | null;

  constructor(data: ToolResultEntryData) {
    super(data);
    this.tool_use_id = data.tool_use_id ?? '';
    this.tool_output = data.tool_output ?? '';
    this.is_error = data.is_error ?? false;
    this.file_path = data.file_path ?? null;
    this.tool_name = data.tool_name ?? null;
    this.duration_ms = data.duration_ms ?? null;
    this.exit_code = data.exit_code ?? null;
    this.output_token_count = data.output_token_count ?? null;
  }
}
