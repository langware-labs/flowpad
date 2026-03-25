/**
 * Claude Code Transcript JSONL Parser
 *
 * A TypeScript library for parsing and analyzing Claude Code transcript files.
 *
 * @example
 * ```typescript
 * import {
 *   parseTranscript,
 *   getTranscriptStats,
 *   getToolUsesByName,
 *   getUserEntries
 * } from '@your-org/flowpad-sdk';
 *
 * const content = await fs.readFile('transcript.jsonl', 'utf-8');
 * const transcript = parseTranscript(content);
 *
 * console.log(getTranscriptStats(transcript));
 * console.log(getToolUsesByName(transcript, 'Edit'));
 * ```
 *
 * MIT License
 */

// Types
export type {
  // Content blocks
  ThinkingBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultContent,
  ToolResultContentItem,
  AssistantContentBlock,
  UserContentBlock,

  // Messages
  AssistantMessage,
  UserMessage,
  TokenUsage,

  // Tool results
  ToolUseResultBase,
  BashToolResult,
  FileToolResult,
  WebFetchToolResult,
  ToolUseResult,

  // Metadata
  ThinkingMetadata,
  TodoItem as TranscriptTodoItem,
  FileBackup,
  FileHistorySnapshot,

  // Entry types
  BaseEntryFields,
  ConversationEntryFields,
  FileHistorySnapshotEntry,
  UserEntry,
  AssistantEntry,
  QueueOperationEntry,
  SummaryEntry,
  SystemEntry,
  ProgressEntry,
  ProgressData,
  HookProgressData,
  BashProgressData,
  AgentProgressData,
  AgentProgressMessage,
  AgentProgressAssistantMessage,
  AgentProgressUserMessage,
  TranscriptEntry,

  // Parsed result
  ParsedTranscript,
} from './types';

// Type guards
export {
  isFileHistorySnapshotEntry,
  isUserEntry,
  isAssistantEntry,
  isQueueOperationEntry,
  isSummaryEntry,
  isSystemEntry,
  isProgressEntry,
  isHookProgressData,
  isBashProgressData,
  isAgentProgressData,
  isThinkingBlock,
  isTextBlock,
  isToolUseBlock,
} from './types';

// Parser functions
export {
  parseTranscriptLine,
  parseTranscriptContent,
  parseTranscript,
  parseTranscriptFile,
  streamParseTranscript,
  validateEntry,
} from './parser';

// Utility functions
export {
  // Entry filtering
  getUserEntries,
  getAssistantEntries,
  getFileHistorySnapshots,
  getConversationEntries,
  getMainConversation,
  getSidechainEntries,

  // Content extraction
  getThinkingBlocks,
  getTextBlocks,
  getToolUseBlocks,
  getToolUsesByName,
  getUniqueToolNames,

  // File tracking
  getTrackedFiles,
  getCreatedFiles,
  getEditedFiles,

  // Todo tracking
  getFinalTodos,
  getTodoHistory,

  // Token usage
  getTotalTokenUsage,

  // Message threading
  buildMessageTree,
  getThread,
  getRootEntries,

  // Search & filter
  searchTranscript,
  filterByTimeRange,
  getEntriesByModel,

  // Statistics
  getTranscriptStats,
} from './utils';
