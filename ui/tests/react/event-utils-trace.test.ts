import { describe, it, expect } from 'vitest';
import { getEventColor, getOneLiner } from '@src/components/hooks/event-utils';
import type { TraceEvent } from '@src/types/trace-event';
import { FlowDataSource } from '@sdk';

function makeEvent(overrides: Partial<TraceEvent>): TraceEvent {
  return {
    id: 'test-1',
    timestamp: '2026-03-08T00:00:00Z',
    source: FlowDataSource.Sniffer,
    session_id: 'sess-1',
    event_type: 'PreToolUse',
    raw: {},
    transcriptDockPointer: null,
    triggerLogDockPointer: null,
    ...overrides,
  };
}

describe('getEventColor', () => {
  it('returns valid color when event.layer is undefined (history events)', () => {
    const event = makeEvent({ source: FlowDataSource.History, layer: undefined });
    const color = getEventColor(event);
    expect(color).toBeTruthy();
    expect(color).not.toBe('undefined');
  });

  it('returns text-emerald-500 for history-source events', () => {
    const event = makeEvent({ source: FlowDataSource.History, event_type: 'tool_result' });
    expect(getEventColor(event)).toBe('text-emerald-500');
  });
});

describe('getOneLiner', () => {
  it('returns tool_name from top-level event.tool_name for history events', () => {
    const event = makeEvent({
      source: FlowDataSource.History,
      tool_name: 'Read',
      tool_input: { file_path: '/foo.ts' },
    });
    expect(getOneLiner(event)).toBe('Read');
  });

  it('falls back to hook_data path for sniffer events', () => {
    const event = makeEvent({
      source: FlowDataSource.Sniffer,
      hook_data: { tool_name: 'Bash', tool_input: { command: 'ls -la' } },
    });
    const result = getOneLiner(event);
    expect(result).toContain('Bash');
  });
});
