/**
 * UsageEntry — per-stream token / request accounting.
 *
 * TS mirror of flow_sdk/transcript_analyzer/entries/usage.py. One entry per
 * chargeable stream from an assistant turn. The backend prices it and ships
 * the result as `cost_usd`.
 */

import { EntryKind, TranscriptEntry, type TranscriptEntryBase } from '../entry';

export type UsageIo = 'input' | 'output';
export type UsageCache = 'none' | 'read' | 'write';
export type UsageCacheTier = 'none' | '5m' | '1h';
export type UsageUnit = 'token' | 'request';

export interface UsageEntryData extends TranscriptEntryBase {
  count: number;
  io: UsageIo;
  unit?: UsageUnit;
  cache?: UsageCache;
  cache_tier?: UsageCacheTier;
  reasoning?: boolean;
  tool?: string | null;
}

export class UsageEntry extends TranscriptEntry {
  override kind = EntryKind.TOKEN_USAGE;

  count: number;
  io: UsageIo;
  unit: UsageUnit;
  cache: UsageCache;
  cache_tier: UsageCacheTier;
  reasoning: boolean;
  tool: string | null;

  constructor(data: UsageEntryData) {
    super(data);
    this.count = data.count;
    this.io = data.io;
    this.unit = data.unit ?? 'token';
    this.cache = data.cache ?? 'none';
    this.cache_tier = data.cache_tier ?? 'none';
    this.reasoning = data.reasoning ?? false;
    this.tool = data.tool ?? null;
  }
}

/**
 * Codex-only carrier for cumulative per-session totals + turn_id. Doesn't
 * participate in cost arithmetic (count is always 0); the per-dim siblings
 * emitted in the same turn carry the chargeable counts.
 */
export interface CodexUsageEntryData extends UsageEntryData {
  total_input_tokens?: number | null;
  total_output_tokens?: number | null;
  turn_id?: string | null;
}

export class CodexUsageEntry extends UsageEntry {
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  turn_id: string | null;

  constructor(data: CodexUsageEntryData) {
    super(data);
    this.total_input_tokens = data.total_input_tokens ?? null;
    this.total_output_tokens = data.total_output_tokens ?? null;
    this.turn_id = data.turn_id ?? null;
  }
}
