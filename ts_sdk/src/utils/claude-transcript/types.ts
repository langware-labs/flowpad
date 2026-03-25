/**
 * Claude Code Transcript JSONL Parser - Type Definitions
 *
 * Based on Claude Code transcript format from ~/.claude/projects/
 * MIT License
 */

// ============================================================================
// Content Block Types (used in messages)
// ============================================================================

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature: string;
}

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content: string | ToolResultContentItem[];
  is_error?: boolean;
}

export interface ToolResultContentItem {
  type: 'text' | 'image';
  text?: string;
  source?: {
    data: string;
    media_type?: string;
  };
}

export type AssistantContentBlock = ThinkingBlock | TextBlock | ToolUseBlock;
export type UserContentBlock = ToolResultContent | { type: 'text'; text: string };

// ============================================================================
// Message Types
// ============================================================================

export interface AssistantMessage {
  model: string;
  id: string;
  type: 'message';
  role: 'assistant';
  content: AssistantContentBlock[];
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: TokenUsage;
}

export interface UserMessage {
  role: 'user';
  content: string | UserContentBlock[];
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens: number;
    ephemeral_1h_input_tokens: number;
  };
  service_tier?: string;
}

// ============================================================================
// Tool Use Result Types
// ============================================================================

export interface ToolUseResultBase {
  message?: string;
}

export interface BashToolResult extends ToolUseResultBase {
  stdout: string;
  stderr: string;
  interrupted: boolean;
  isImage: boolean;
  backgroundTaskId?: string;
}

export interface FileToolResult extends ToolUseResultBase {
  type: 'create' | 'edit' | 'read';
  filePath: string;
  content?: string;
  structuredPatch?: unknown[];
  originalFile?: string | null;
}

export interface WebFetchToolResult extends ToolUseResultBase {
  bytes: number;
  code: number;
  codeText: string;
  result: string;
  durationMs: number;
  url: string;
}

export type ToolUseResult =
  | BashToolResult
  | FileToolResult
  | WebFetchToolResult
  | ToolUseResultBase
  | Record<string, unknown>;

// ============================================================================
// Metadata Types
// ============================================================================

export interface ThinkingMetadata {
  level: 'none' | 'low' | 'medium' | 'high';
  disabled: boolean;
  triggers: string[];
}

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string;
}

export interface FileBackup {
  backupFileName: string | null;
  version: number;
  backupTime: string;
}

export interface FileHistorySnapshot {
  messageId: string;
  trackedFileBackups: Record<string, FileBackup>;
  timestamp: string;
}

// ============================================================================
// Base Entry Fields
// ============================================================================

export interface BaseEntryFields {
  uuid: string;
  timestamp: string;
  sessionId: string;
}

export interface ConversationEntryFields extends BaseEntryFields {
  parentUuid: string | null;
  isSidechain: boolean;
  userType: 'external' | 'internal';
  cwd: string;
  version: string;
  gitBranch: string;
  slug?: string;
}

// ============================================================================
// Transcript Entry Types (Discriminated Union)
// ============================================================================

export interface FileHistorySnapshotEntry extends BaseEntryFields {
  type: 'file-history-snapshot';
  messageId: string;
  snapshot: FileHistorySnapshot;
  isSnapshotUpdate: boolean;
}

export interface UserEntry extends ConversationEntryFields {
  type: 'user';
  message: UserMessage;
  thinkingMetadata?: ThinkingMetadata;
  todos?: TodoItem[];
  toolUseResult?: ToolUseResult;
}

export interface AssistantEntry extends ConversationEntryFields {
  type: 'assistant';
  message: AssistantMessage;
  requestId: string;
}

export interface QueueOperationEntry extends BaseEntryFields {
  type: 'queue-operation';
  operation: 'enqueue' | 'remove';
  content?: string;
}

export interface SummaryEntry extends BaseEntryFields {
  type: 'summary';
  summary: string;
  leafUuids: string[];
}

export interface SystemEntry extends BaseEntryFields {
  type: 'system';
  message: string;
}

// Progress entry data types
export interface HookProgressData {
  type: 'hook_progress';
  hookEvent: string;
  hookName: string;
  command: string;
}

export interface BashProgressData {
  type: 'bash_progress';
  output: string;
  fullOutput: string;
  elapsedTimeSeconds: number;
  totalLines: number;
}

export interface AgentProgressAssistantMessage {
  type: 'assistant';
  timestamp?: string;
  message: AssistantMessage;
  requestId?: string;
  uuid?: string;
}

export interface AgentProgressUserMessage {
  type: 'user';
  timestamp?: string;
  message: UserMessage;
  uuid?: string;
  toolUseResult?: string;
}

export type AgentProgressMessage = AgentProgressAssistantMessage | AgentProgressUserMessage;

export interface AgentProgressData {
  type: 'agent_progress';
  message: AgentProgressMessage;
  normalizedMessages: unknown[];
  prompt: string;
  agentId: string;
}

export type ProgressData = HookProgressData | BashProgressData | AgentProgressData;

export interface ProgressEntry extends BaseEntryFields {
  type: 'progress';
  data: ProgressData;
  toolUseID?: string;
  parentToolUseID?: string;
}

// Main discriminated union for all entry types
export type TranscriptEntry =
  | FileHistorySnapshotEntry
  | UserEntry
  | AssistantEntry
  | QueueOperationEntry
  | SummaryEntry
  | SystemEntry
  | ProgressEntry;

// ============================================================================
// Parsed Transcript
// ============================================================================

export interface ParsedTranscript {
  entries: TranscriptEntry[];
  sessionId: string | null;
  version: string | null;
  cwd: string | null;
  gitBranch: string | null;
  startTime: Date | null;
  endTime: Date | null;
}

// ============================================================================
// Type Guards
// ============================================================================

export function isFileHistorySnapshotEntry(entry: TranscriptEntry): entry is FileHistorySnapshotEntry {
  return entry.type === 'file-history-snapshot';
}

export function isUserEntry(entry: TranscriptEntry): entry is UserEntry {
  return entry.type === 'user';
}

export function isAssistantEntry(entry: TranscriptEntry): entry is AssistantEntry {
  return entry.type === 'assistant';
}

export function isQueueOperationEntry(entry: TranscriptEntry): entry is QueueOperationEntry {
  return entry.type === 'queue-operation';
}

export function isSummaryEntry(entry: TranscriptEntry): entry is SummaryEntry {
  return entry.type === 'summary';
}

export function isSystemEntry(entry: TranscriptEntry): entry is SystemEntry {
  return entry.type === 'system';
}

export function isProgressEntry(entry: TranscriptEntry): entry is ProgressEntry {
  return entry.type === 'progress';
}

// Progress data type guards
export function isHookProgressData(data: ProgressData): data is HookProgressData {
  return data.type === 'hook_progress';
}

export function isBashProgressData(data: ProgressData): data is BashProgressData {
  return data.type === 'bash_progress';
}

export function isAgentProgressData(data: ProgressData): data is AgentProgressData {
  return data.type === 'agent_progress';
}

// Content block type guards
export function isThinkingBlock(block: AssistantContentBlock): block is ThinkingBlock {
  return block.type === 'thinking';
}

export function isTextBlock(block: AssistantContentBlock): block is TextBlock {
  return block.type === 'text';
}

export function isToolUseBlock(block: AssistantContentBlock): block is ToolUseBlock {
  return block.type === 'tool_use';
}
