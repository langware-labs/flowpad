/**
 * Claude Code Transcript JSONL Parser
 *
 * Parses JSONL transcript files from ~/.claude/projects/
 * MIT License
 */

import type { TranscriptEntry, ParsedTranscript, UserEntry, AssistantEntry } from './types';

/**
 * Parse a single line of JSONL into a TranscriptEntry
 */
export function parseTranscriptLine(line: string): TranscriptEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);

    // Validate that it has a type field
    if (!parsed.type) {
      console.warn('Transcript entry missing type field:', parsed);
      return null;
    }

    return parsed as TranscriptEntry;
  } catch (error) {
    console.warn('Failed to parse transcript line:', error);
    return null;
  }
}

/**
 * Parse JSONL content string into an array of TranscriptEntry objects
 */
export function parseTranscriptContent(content: string): TranscriptEntry[] {
  const lines = content.split('\n');
  const entries: TranscriptEntry[] = [];

  for (const line of lines) {
    const entry = parseTranscriptLine(line);
    if (entry) {
      entries.push(entry);
    }
  }

  return entries;
}

/**
 * Parse a complete transcript and extract metadata
 */
export function parseTranscript(content: string): ParsedTranscript {
  const entries = parseTranscriptContent(content);

  // Extract metadata from first conversation entry
  let sessionId: string | null = null;
  let version: string | null = null;
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let startTime: Date | null = null;
  let endTime: Date | null = null;

  for (const entry of entries) {
    // Update timestamps
    if (entry.timestamp) {
      const time = new Date(entry.timestamp);
      if (!startTime || time < startTime) startTime = time;
      if (!endTime || time > endTime) endTime = time;
    }

    // Extract metadata from conversation entries
    if (entry.type === 'user' || entry.type === 'assistant') {
      const convEntry = entry as UserEntry | AssistantEntry;
      if (!sessionId && convEntry.sessionId) sessionId = convEntry.sessionId;
      if (!version && convEntry.version) version = convEntry.version;
      if (!cwd && convEntry.cwd) cwd = convEntry.cwd;
      if (!gitBranch && convEntry.gitBranch) gitBranch = convEntry.gitBranch;
    }
  }

  return {
    entries,
    sessionId,
    version,
    cwd,
    gitBranch,
    startTime,
    endTime,
  };
}

/**
 * Parse a transcript from a File object (browser)
 */
export async function parseTranscriptFile(file: File): Promise<ParsedTranscript> {
  const content = await file.text();
  return parseTranscript(content);
}

/**
 * Stream parse a large JSONL file line by line
 * Returns an async generator for memory-efficient processing
 */
export async function* streamParseTranscript(content: string): AsyncGenerator<TranscriptEntry, void, unknown> {
  const lines = content.split('\n');

  for (const line of lines) {
    const entry = parseTranscriptLine(line);
    if (entry) {
      yield entry;
    }
  }
}

/**
 * Validate a transcript entry has required fields
 */
export function validateEntry(entry: unknown): entry is TranscriptEntry {
  if (!entry || typeof entry !== 'object') return false;

  const obj = entry as Record<string, unknown>;

  // Must have type
  if (!obj.type || typeof obj.type !== 'string') return false;

  // Must have timestamp
  if (!obj.timestamp || typeof obj.timestamp !== 'string') return false;

  // Type-specific validation
  switch (obj.type) {
    case 'user':
    case 'assistant':
      return typeof obj.uuid === 'string' && typeof obj.sessionId === 'string' && obj.message !== undefined;

    case 'file-history-snapshot':
      return obj.snapshot !== undefined && typeof obj.messageId === 'string';

    case 'queue-operation':
      return typeof obj.operation === 'string';

    case 'summary':
      return typeof obj.summary === 'string';

    case 'system':
      return typeof obj.message === 'string';

    default:
      // Unknown type - still valid but warn
      console.warn(`Unknown transcript entry type: ${obj.type}`);
      return true;
  }
}
