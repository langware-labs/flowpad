/**
 * Worker-agnostic transcript types.
 *
 * The renderer operates on `UnifiedEntry` — one row per logical turn — built
 * by `groupEntriesByTurn()` from the typed `GenericEntry[]` the server emits.
 * One raw assistant turn (a Claude `assistant` line, a Codex stream event)
 * may produce multiple `GenericEntry` rows (text + tool_use + token_usage);
 * those collapse back into a single `UnifiedEntry` for rendering.
 */

import type { GenericEntry } from '@sdk';

export type UnifiedRole = 'user' | 'assistant' | 'system' | 'summary' | 'meta' | 'unknown';

export interface ToolUse {
  name: string;
  toolUseId: string;
  input: unknown;
}

export interface ToolResult {
  toolUseId: string;
  output: string;
  isError: boolean;
  filePath?: string | null;
  durationMs?: number | null;
  exitCode?: number | null;
}

export interface TokenUsage {
  input?: number | null;
  output?: number | null;
  cached?: number | null;
  cacheRead?: number | null;
  cacheCreation?: number | null;
  reasoning?: number | null;
}

export interface UnifiedEntry {
  /** Turn id — base id of the source line (without `:usage` suffix). */
  id: string;
  /** ISO timestamp from the source line. */
  timestamp: string;
  sessionId: string;
  parentId: string | null;
  isSidechain: boolean;
  /** Top-level role for filter / styling decisions. */
  role: UnifiedRole;

  // Conversational content (user / assistant)
  text?: string;
  thinking?: string;
  toolUse?: ToolUse;          // assistant turn that's a tool call
  toolResult?: ToolResult;    // user turn that's a tool response
  usage?: TokenUsage;         // assistant turn token accounting

  // System / meta / summary content
  subtype?: string;           // SystemEntry.subtype, MetaEntry.meta_kind, etc.
  payload?: Record<string, unknown>;
  summary?: string;

  // For the info modal: the original source rows that produced this turn.
  rawEntries: GenericEntry[];
}
