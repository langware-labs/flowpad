/**
 * Unified transcript analyzer for agentic workers — TypeScript mirror.
 *
 * Mirrors the public surface of flow_sdk/transcript_analyzer/__init__.py.
 * Parsing of raw JSONL stays server-side; this module only types the REST
 * round-trip and provides `fromJson` to hydrate serialized entries into
 * the right TranscriptEntry subclass.
 */

import {
  AssistantMessageEntry,
  ExitPlanModeEntry,
  MetaEntry,
  SummaryEntry,
  SystemEntry,
  ToolResultEntry,
  ToolUseEntry,
  UnknownEntry,
  UsageEntry,
  UserMessageEntry,
} from './entries';
import { EntryKind, TranscriptEntry } from './entry';

export { extract_text, extract_thinking, first_block_of_type, flatten_tool_result } from './_helpers';
export {
  AssistantMessageEntry,
  CodexUsageEntry,
  ExitPlanModeEntry,
  MetaEntry,
  SummaryEntry,
  SystemEntry,
  ToolResultEntry,
  ToolUseEntry,
  UnknownEntry,
  UsageEntry,
  UserMessageEntry,
  type AssistantMessageEntryData,
  type CodexUsageEntryData,
  type MetaEntryData,
  type SummaryEntryData,
  type SystemEntryData,
  type ToolResultEntryData,
  type ToolUseEntryData,
  type UnknownEntryData,
  type UsageEntryData,
  type UserMessageEntryData,
} from './entries';
export { EntryKind, TranscriptEntry, type TranscriptEntryBase } from './entry';
export { parseClaudeTranscriptUsage } from './parse-claude-usage';
export { CLAUDE_PRICING, ModelPricing, pricingFor } from './pricing';
export type { ItemPrice } from './pricing';
export { AgentTranscriptFile as AgentTranscript, TranscriptFormat, TranscriptSource } from './transcript';

/**
 * Hydrate a REST-serialized entry payload into the right TranscriptEntry
 * subclass. Discriminates on `kind`; for TOOL_USE further inspects
 * `tool_name` to pick up the ExitPlanMode subclass.
 */
export function fromJson(raw: Record<string, unknown>): TranscriptEntry {
  const kind = raw['kind'] as EntryKind;
  switch (kind) {
    case EntryKind.USER_MESSAGE:
      return new UserMessageEntry(raw as never);
    case EntryKind.ASSISTANT_MESSAGE:
      return new AssistantMessageEntry(raw as never);
    case EntryKind.TOOL_USE:
      if (raw['tool_name'] === 'ExitPlanMode') {
        return new ExitPlanModeEntry(raw as never);
      }
      return new ToolUseEntry(raw as never);
    case EntryKind.TOOL_RESULT:
      return new ToolResultEntry(raw as never);
    case EntryKind.META:
      return new MetaEntry(raw as never);
    case EntryKind.TOKEN_USAGE:
      return new UsageEntry(raw as never);
    case EntryKind.SYSTEM:
      return new SystemEntry(raw as never);
    case EntryKind.SUMMARY:
      return new SummaryEntry(raw as never);
    default:
      return new UnknownEntry(raw as never);
  }
}
