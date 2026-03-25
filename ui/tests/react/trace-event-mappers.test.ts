import { describe, it, expect } from 'vitest';
import {
  mapSnifferToTraceEvent,
  mapTranscriptToTraceEvents,
  type TranscriptEntryData,
} from '@src/types/trace-event';
import type { SnifferEvent } from '@src/hooks/use-hooks-sniffer';

describe('mapSnifferToTraceEvent', () => {
  const baseSniffer: SnifferEvent = {
    id: '2026-03-08T00:00:00Z-0',
    idx: 42,
    timestamp: '2026-03-08T00:00:00Z',
    webhook_type: 'agent_hook',
    event_type: 'PreToolUse',
    session_id: 'sess-123',
    hook_data: { tool_name: 'Read', tool_input: { file_path: '/foo.ts' } },
    raw_line: '{"webhook_type":"agent_hook","hook_data":{"tool_name":"Read"}}',
    layer: 'debug',
  };

  it('preserves idx from SnifferEvent', () => {
    const result = mapSnifferToTraceEvent(baseSniffer);
    expect(result.idx).toBe(42);
    expect(result.source).toBe('sniffer');
  });

  it('parses raw_line JSON into raw object', () => {
    const result = mapSnifferToTraceEvent(baseSniffer);
    expect(result.raw).toEqual({ webhook_type: 'agent_hook', hook_data: { tool_name: 'Read' } });
  });

  it('falls back to { raw_line } for non-JSON raw_line', () => {
    const event = { ...baseSniffer, raw_line: 'not-json' };
    const result = mapSnifferToTraceEvent(event);
    expect(result.raw).toEqual({ raw_line: 'not-json' });
  });

  it('has source "sniffer"', () => {
    expect(mapSnifferToTraceEvent(baseSniffer).source).toBe('sniffer');
  });
});

describe('mapTranscriptToTraceEvents', () => {
  it('produces one event per tool_use block for assistant entries', () => {
    const entry: TranscriptEntryData = {
      entry_type: 'assistant',
      entry_uuid: 'uuid-1',
      timestamp: '2026-03-08T00:01:00Z',
      session_id: 'sess-123',
      message: {
        content: [
          { type: 'text', text: 'Let me read that file.' },
          { type: 'tool_use', name: 'Read', id: 'tu-1', input: { file_path: '/a.ts' } },
          { type: 'tool_use', name: 'Bash', id: 'tu-2', input: { command: 'ls' } },
        ],
      },
    };
    const result = mapTranscriptToTraceEvents(entry, 'sess-123');
    expect(result).toHaveLength(2);
    expect(result[0].event_type).toBe('Read');
    expect(result[0].tool_name).toBe('Read');
    expect(result[1].event_type).toBe('Bash');
    expect(result[1].tool_input).toEqual({ command: 'ls' });
  });

  it('handles user entries', () => {
    const entry: TranscriptEntryData = {
      entry_type: 'user',
      entry_uuid: 'uuid-2',
      timestamp: '2026-03-08T00:00:00Z',
      session_id: 'sess-123',
      message: { content: 'Fix the bug' },
    };
    const result = mapTranscriptToTraceEvents(entry, 'sess-123');
    expect(result).toHaveLength(1);
    expect(result[0].event_type).toBe('UserMessage');
    expect(result[0].source).toBe('transcript');
  });

  it('handles assistant text-only entries', () => {
    const entry: TranscriptEntryData = {
      entry_type: 'assistant',
      entry_uuid: 'uuid-3',
      timestamp: '2026-03-08T00:00:30Z',
      session_id: 'sess-123',
      message: { content: [{ type: 'text', text: 'Done.' }] },
    };
    const result = mapTranscriptToTraceEvents(entry, 'sess-123');
    expect(result).toHaveLength(1);
    expect(result[0].event_type).toBe('AssistantMessage');
  });

  it('handles system entries', () => {
    const entry: TranscriptEntryData = {
      entry_type: 'system',
      entry_uuid: 'uuid-4',
      timestamp: '2026-03-08T00:02:00Z',
      session_id: 'sess-123',
      subtype: 'turn_duration',
    };
    const result = mapTranscriptToTraceEvents(entry, 'sess-123');
    expect(result).toHaveLength(1);
    expect(result[0].event_type).toBe('System:turn_duration');
  });

  it('all transcript events have source "transcript" and idx undefined', () => {
    const entry: TranscriptEntryData = {
      entry_type: 'user',
      entry_uuid: 'uuid-5',
      timestamp: '2026-03-08T00:00:00Z',
      session_id: 'sess-123',
      message: { content: 'hi' },
    };
    const result = mapTranscriptToTraceEvents(entry, 'sess-123');
    expect(result[0].source).toBe('transcript');
    expect(result[0].idx).toBeUndefined();
  });
});
