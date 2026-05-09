/** ToolUseEntry — an assistant invoking a tool. */

import { EntryKind, TranscriptEntry, type TranscriptEntryBase } from '../entry';

export interface ToolUseEntryData extends TranscriptEntryBase {
  tool_name: string;
  tool_use_id: string;
  tool_input: Record<string, unknown>;
}

export class ToolUseEntry extends TranscriptEntry {
  override kind = EntryKind.TOOL_USE;

  tool_name: string;
  tool_use_id: string;
  tool_input: Record<string, unknown>;

  constructor(data: ToolUseEntryData) {
    super(data);
    this.tool_name = data.tool_name ?? '';
    this.tool_use_id = data.tool_use_id ?? '';
    this.tool_input = data.tool_input ?? {};
  }
}
