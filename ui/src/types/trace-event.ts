import type { EventLayer, SnifferEvent } from '@src/hooks/use-hooks-sniffer';

export type TraceEventSource = 'transcript' | 'sniffer';

export type { EventLayer };

export type { TranscriptEntryData } from '@sdk/resource_management/fs_records/claude/transcript/transcript-entry.js';

export interface ClaudeTraceEvent {
  id: string;
  idx?: number;
  timestamp: string;
  source: TraceEventSource;
  session_id: string;
  event_type: string;
  summary?: string;
  tool_name?: string;
  tool_input?: Record<string, any>;
  absRow?: number;
  raw: Record<string, any>;
  transcript_path?: string;
  webhook_type?: string;
  hook_data?: Record<string, any>;
  layer?: EventLayer;
  warning?: string;
  error?: string;
  /** Pre-computed transcript lens pointer. Null for SessionStart, events without a transcript, and transcript-source events (need projectEncodedName from context). */
  transcriptDockPointer: { ref: string; options: Record<string, string> } | null;
  /** Pre-computed trigger log lens pointer. Null for events without a hook_entry_id. */
  triggerLogDockPointer: { ref: string; options: Record<string, string> } | null;
}

/**
 * Map a live SnifferEvent to a ClaudeTraceEvent.
 *
 * - Parses `event.raw_line` via JSON.parse; falls back to `{ raw_line: event.raw_line }`.
 * - Preserves `event.idx`.
 */
export function mapSnifferToTraceEvent(event: SnifferEvent): ClaudeTraceEvent {
  let raw: Record<string, any>;
  try {
    raw = JSON.parse(event.raw_line);
  } catch {
    raw = { raw_line: event.raw_line };
  }

  return {
    id: event.id,
    idx: event.idx,
    timestamp: event.timestamp,
    source: 'sniffer',
    session_id: event.session_id ?? '',
    event_type: event.event_type,
    summary: event.summary,
    tool_name: event.hook_data?.tool_name,
    tool_input: event.hook_data?.tool_input,
    raw,
    transcript_path: event.transcript_path,
    webhook_type: event.webhook_type,
    hook_data: event.hook_data,
    layer: event.layer,
    warning: event.warning,
    error: event.error,
    transcriptDockPointer: event.transcriptDockPointer,
    triggerLogDockPointer: event.triggerLogDockPointer,
  };
}

/**
 * Map a transcript entry to one or more ClaudeTraceEvents.
 *
 * - Assistant entries with tool_use content blocks produce one event per tool block.
 * - All other entry types produce exactly one event.
 * - `idx` is undefined for all transcript events.
 * - `raw` is the entry object itself.
 */
export function mapTranscriptToTraceEvents(
  entry: TranscriptEntryData,
  sessionId: string,
): ClaudeTraceEvent[] {
  const baseFields = {
    timestamp: entry.timestamp,
    source: 'transcript' as const,
    session_id: sessionId,
    raw: entry as unknown as Record<string, any>,
    transcriptDockPointer: null as null,
    triggerLogDockPointer: null as null,
  };

  // Assistant with tool_use blocks -> one event per tool
  if (entry.entry_type === 'assistant' && Array.isArray(entry.message?.content)) {
    const content: any[] = entry.message?.content;
    const toolBlocks = content.filter(
      (b: any) => typeof b === 'object' && b?.type === 'tool_use',
    );
    if (toolBlocks.length > 0) {
      return toolBlocks.map((block: any, i: number) => ({
        ...baseFields,
        id: `transcript-${entry.entry_uuid}-tool-${i}`,
        event_type: block.name || 'UnknownTool',
        tool_name: block.name,
        tool_input: block.input,
      }));
    }
    // Assistant text-only
    return [{
      ...baseFields,
      id: `transcript-${entry.entry_uuid}`,
      event_type: 'AssistantMessage',
      summary: extractTextSummary(entry.message?.content),
    }];
  }

  if (entry.entry_type === 'user') {
    // Skip tool_result-only entries (automated responses, not user-typed prompts)
    const content = entry.message?.content;
    const isToolResultOnly = Array.isArray(content) &&
      content.length > 0 &&
      content.every((b: any) => b?.type === 'tool_result');
    if (isToolResultOnly) return [];

    return [{
      ...baseFields,
      id: `transcript-${entry.entry_uuid}`,
      event_type: 'UserMessage',
      summary: extractTextSummary(entry.message?.content),
    }];
  }

  if (entry.entry_type === 'system') {
    return [{
      ...baseFields,
      id: `transcript-${entry.entry_uuid}`,
      event_type: `System:${entry.subtype || 'unknown'}`,
    }];
  }

  // All other types (progress, summary, queue-operation, etc.)
  return [{
    ...baseFields,
    id: `transcript-${entry.entry_uuid}`,
    event_type: entry.entry_type || 'Unknown',
  }];
}

/** Extract short text summary from message content. */
function extractTextSummary(content: any): string | undefined {
  if (typeof content === 'string') return content.slice(0, 80);
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === 'object' && block?.type === 'text' && block.text) {
        return (block.text as string).slice(0, 80);
      }
    }
  }
  return undefined;
}
