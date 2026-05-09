/**
 * Worker-agnostic transcript types + parser.
 *
 * Mirrors `flow_sdk/transcript_analyzer/` on the server. Consume via the
 * `useTranscript()` React hook — this module is the typed contract for
 * the response of `GET /api/v1/transcripts/{worker_type}`.
 */

export type {
  EntryKind,
  BaseEntry,
  UserMessageEntry,
  AssistantMessageEntry,
  ToolUseEntry,
  ToolResultEntry,
  SystemEntry,
  SummaryEntry,
  MetaEntry,
  TokenUsageEntry,
  UnknownEntry,
  GenericEntry,
  TranscriptHeader,
  ParsedTranscript,
} from './entries';

export {
  isUserMessage,
  isAssistantMessage,
  isToolUse,
  isToolResult,
  isSystem,
  isSummary,
  isMeta,
  isTokenUsage,
  isUnknown,
} from './entries';

export { parseTranscriptResponse } from './parser';
