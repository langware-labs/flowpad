/**
 * Claude Code Transcript Utilities
 *
 * Helper functions for querying and analyzing parsed transcripts
 * MIT License
 */

import type {
  TranscriptEntry,
  ParsedTranscript,
  UserEntry,
  AssistantEntry,
  FileHistorySnapshotEntry,
  ThinkingBlock,
  TextBlock,
  ToolUseBlock,
  TodoItem,
  FileBackup,
} from './types';

import {
  isUserEntry,
  isAssistantEntry,
  isFileHistorySnapshotEntry,
  isThinkingBlock,
  isTextBlock,
  isToolUseBlock,
} from './types';

// ============================================================================
// Entry Filtering
// ============================================================================

/**
 * Get all user entries from a transcript
 */
export function getUserEntries(transcript: ParsedTranscript): UserEntry[] {
  return transcript.entries.filter(isUserEntry);
}

/**
 * Get all assistant entries from a transcript
 */
export function getAssistantEntries(transcript: ParsedTranscript): AssistantEntry[] {
  return transcript.entries.filter(isAssistantEntry);
}

/**
 * Get all file history snapshot entries
 */
export function getFileHistorySnapshots(transcript: ParsedTranscript): FileHistorySnapshotEntry[] {
  return transcript.entries.filter(isFileHistorySnapshotEntry);
}

/**
 * Get conversation entries (user + assistant) in order
 */
export function getConversationEntries(transcript: ParsedTranscript): (UserEntry | AssistantEntry)[] {
  return transcript.entries.filter((e): e is UserEntry | AssistantEntry => isUserEntry(e) || isAssistantEntry(e));
}

/**
 * Get entries from main conversation (not sidechains)
 */
export function getMainConversation(transcript: ParsedTranscript): (UserEntry | AssistantEntry)[] {
  return getConversationEntries(transcript).filter((e) => !e.isSidechain);
}

/**
 * Get sidechain (subagent) entries
 */
export function getSidechainEntries(transcript: ParsedTranscript): (UserEntry | AssistantEntry)[] {
  return getConversationEntries(transcript).filter((e) => e.isSidechain);
}

// ============================================================================
// Content Extraction
// ============================================================================

/**
 * Extract all thinking blocks from assistant entries
 */
export function getThinkingBlocks(transcript: ParsedTranscript): ThinkingBlock[] {
  const blocks: ThinkingBlock[] = [];

  for (const entry of getAssistantEntries(transcript)) {
    for (const block of entry.message.content) {
      if (isThinkingBlock(block)) {
        blocks.push(block);
      }
    }
  }

  return blocks;
}

/**
 * Extract all text blocks from assistant entries
 */
export function getTextBlocks(transcript: ParsedTranscript): TextBlock[] {
  const blocks: TextBlock[] = [];

  for (const entry of getAssistantEntries(transcript)) {
    for (const block of entry.message.content) {
      if (isTextBlock(block)) {
        blocks.push(block);
      }
    }
  }

  return blocks;
}

/**
 * Extract all tool use blocks from assistant entries
 */
export function getToolUseBlocks(transcript: ParsedTranscript): ToolUseBlock[] {
  const blocks: ToolUseBlock[] = [];

  for (const entry of getAssistantEntries(transcript)) {
    for (const block of entry.message.content) {
      if (isToolUseBlock(block)) {
        blocks.push(block);
      }
    }
  }

  return blocks;
}

/**
 * Get all tool uses of a specific tool name
 */
export function getToolUsesByName(transcript: ParsedTranscript, toolName: string): ToolUseBlock[] {
  return getToolUseBlocks(transcript).filter((block) => block.name === toolName);
}

/**
 * Get unique tool names used in the transcript
 */
export function getUniqueToolNames(transcript: ParsedTranscript): string[] {
  const names = new Set<string>();

  for (const block of getToolUseBlocks(transcript)) {
    names.add(block.name);
  }

  return Array.from(names).sort();
}

// ============================================================================
// File Tracking
// ============================================================================

/**
 * Get all files that were tracked/modified during the session
 */
export function getTrackedFiles(transcript: ParsedTranscript): Map<string, FileBackup[]> {
  const fileMap = new Map<string, FileBackup[]>();

  for (const snapshot of getFileHistorySnapshots(transcript)) {
    for (const [filePath, backup] of Object.entries(snapshot.snapshot.trackedFileBackups)) {
      const existing = fileMap.get(filePath) || [];
      existing.push(backup);
      fileMap.set(filePath, existing);
    }
  }

  return fileMap;
}

/**
 * Get files that were created during the session
 */
export function getCreatedFiles(transcript: ParsedTranscript): string[] {
  const files: string[] = [];
  const fileMap = getTrackedFiles(transcript);

  Array.from(fileMap.entries()).forEach(([filePath, backups]) => {
    // File was created if first backup has no original
    if (backups.length > 0 && backups[0].backupFileName === null) {
      files.push(filePath);
    }
  });

  return files;
}

/**
 * Get files that were edited during the session
 */
export function getEditedFiles(transcript: ParsedTranscript): string[] {
  const files: string[] = [];
  const fileMap = getTrackedFiles(transcript);

  Array.from(fileMap.entries()).forEach(([filePath, backups]) => {
    // File was edited if it has a backup file
    if (backups.some((b) => b.backupFileName !== null)) {
      files.push(filePath);
    }
  });

  return files;
}

// ============================================================================
// Todo Tracking
// ============================================================================

/**
 * Get the final todo list state from the transcript
 */
export function getFinalTodos(transcript: ParsedTranscript): TodoItem[] | null {
  const userEntries = getUserEntries(transcript);

  // Find the last entry with todos
  for (let i = userEntries.length - 1; i >= 0; i--) {
    if (userEntries[i].todos && userEntries[i].todos!.length > 0) {
      return userEntries[i].todos!;
    }
  }

  return null;
}

/**
 * Get todo list history (all todo states throughout the session)
 */
export function getTodoHistory(transcript: ParsedTranscript): { timestamp: string; todos: TodoItem[] }[] {
  const history: { timestamp: string; todos: TodoItem[] }[] = [];

  for (const entry of getUserEntries(transcript)) {
    if (entry.todos && entry.todos.length > 0) {
      history.push({
        timestamp: entry.timestamp,
        todos: entry.todos,
      });
    }
  }

  return history;
}

// ============================================================================
// Token Usage
// ============================================================================

/**
 * Calculate total token usage for the session
 */
export function getTotalTokenUsage(transcript: ParsedTranscript): {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
} {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;

  for (const entry of getAssistantEntries(transcript)) {
    const usage = entry.message.usage;
    if (usage) {
      inputTokens += usage.input_tokens || 0;
      outputTokens += usage.output_tokens || 0;
      cacheCreationTokens += usage.cache_creation_input_tokens || 0;
      cacheReadTokens += usage.cache_read_input_tokens || 0;
    }
  }

  return {
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
  };
}

// ============================================================================
// Message Threading
// ============================================================================

/**
 * Build a message tree from transcript entries
 */
export function buildMessageTree(transcript: ParsedTranscript): Map<string, TranscriptEntry[]> {
  const tree = new Map<string, TranscriptEntry[]>();

  for (const entry of transcript.entries) {
    if ('parentUuid' in entry && entry.parentUuid) {
      const children = tree.get(entry.parentUuid) || [];
      children.push(entry);
      tree.set(entry.parentUuid, children);
    }
  }

  return tree;
}

/**
 * Get the conversation thread starting from a specific message
 */
export function getThread(transcript: ParsedTranscript, startUuid: string): TranscriptEntry[] {
  const thread: TranscriptEntry[] = [];
  const tree = buildMessageTree(transcript);

  function traverse(uuid: string) {
    const entry = transcript.entries.find((e) => e.uuid === uuid);
    if (entry) {
      thread.push(entry);
      const children = tree.get(uuid) || [];
      for (const child of children) {
        traverse(child.uuid);
      }
    }
  }

  traverse(startUuid);
  return thread;
}

/**
 * Get root entries (entries with no parent)
 */
export function getRootEntries(transcript: ParsedTranscript): TranscriptEntry[] {
  return transcript.entries.filter((e) => {
    if ('parentUuid' in e) {
      return e.parentUuid === null;
    }
    return true;
  });
}

// ============================================================================
// Search & Filter
// ============================================================================

/**
 * Search transcript for entries containing text
 */
export function searchTranscript(
  transcript: ParsedTranscript,
  query: string,
  options: { caseSensitive?: boolean } = {},
): TranscriptEntry[] {
  const { caseSensitive = false } = options;
  const searchQuery = caseSensitive ? query : query.toLowerCase();

  return transcript.entries.filter((entry) => {
    const json = JSON.stringify(entry);
    const searchIn = caseSensitive ? json : json.toLowerCase();
    return searchIn.includes(searchQuery);
  });
}

/**
 * Filter entries by time range
 */
export function filterByTimeRange(transcript: ParsedTranscript, startTime: Date, endTime: Date): TranscriptEntry[] {
  return transcript.entries.filter((entry) => {
    const time = new Date(entry.timestamp);
    return time >= startTime && time <= endTime;
  });
}

/**
 * Get entries by model name
 */
export function getEntriesByModel(transcript: ParsedTranscript, modelName: string): AssistantEntry[] {
  return getAssistantEntries(transcript).filter((entry) => entry.message.model.includes(modelName));
}

// ============================================================================
// Statistics
// ============================================================================

/**
 * Get transcript statistics
 */
export function getTranscriptStats(transcript: ParsedTranscript): {
  totalEntries: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  uniqueTools: number;
  filesTracked: number;
  filesCreated: number;
  filesEdited: number;
  duration: number | null;
  models: string[];
} {
  const toolBlocks = getToolUseBlocks(transcript);
  const trackedFiles = getTrackedFiles(transcript);
  const models = new Set<string>();

  for (const entry of getAssistantEntries(transcript)) {
    models.add(entry.message.model);
  }

  let duration: number | null = null;
  if (transcript.startTime && transcript.endTime) {
    duration = transcript.endTime.getTime() - transcript.startTime.getTime();
  }

  return {
    totalEntries: transcript.entries.length,
    userMessages: getUserEntries(transcript).length,
    assistantMessages: getAssistantEntries(transcript).length,
    toolCalls: toolBlocks.length,
    uniqueTools: getUniqueToolNames(transcript).length,
    filesTracked: trackedFiles.size,
    filesCreated: getCreatedFiles(transcript).length,
    filesEdited: getEditedFiles(transcript).length,
    duration,
    models: Array.from(models),
  };
}
