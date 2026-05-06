/** TokenUsageEntry — token counters reported by the worker. */

import { EntryKind, TranscriptEntry, type TranscriptEntryBase } from '../entry';

export interface TokenUsageEntryData extends TranscriptEntryBase {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cached_input_tokens?: number | null;
  reasoning_output_tokens?: number | null;
  total_input_tokens?: number | null;
  total_output_tokens?: number | null;
  turn_id?: string | null;
}

export class TokenUsageEntry extends TranscriptEntry {
  override kind = EntryKind.TOKEN_USAGE;

  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  reasoning_output_tokens: number | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  turn_id: string | null;

  constructor(data: TokenUsageEntryData) {
    super(data);
    this.input_tokens = data.input_tokens ?? null;
    this.output_tokens = data.output_tokens ?? null;
    this.cached_input_tokens = data.cached_input_tokens ?? null;
    this.reasoning_output_tokens = data.reasoning_output_tokens ?? null;
    this.total_input_tokens = data.total_input_tokens ?? null;
    this.total_output_tokens = data.total_output_tokens ?? null;
    this.turn_id = data.turn_id ?? null;
  }
}
