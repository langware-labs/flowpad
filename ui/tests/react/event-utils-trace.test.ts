import { describe, it, expect } from 'vitest';
import { getEventColor, getOneLiner } from '@src/components/hooks/event-utils';
import type { ClaudeTraceEvent } from '@src/types/trace-event';

function makeEvent(overrides: Partial<ClaudeTraceEvent>): ClaudeTraceEvent {
  return {
    id: 'test-1',
    timestamp: '2026-03-08T00:00:00Z',
    source: 'sniffer',
    session_id: 'sess-1',
    event_type: 'PreToolUse',
    raw: {},
    ...overrides,
  };
}

describe('getEventColor', () => {
  it('returns valid color when event.layer is undefined (transcript events)', () => {
    const event = makeEvent({ source: 'transcript', layer: undefined });
    const color = getEventColor(event);
    expect(color).toBeTruthy();
    expect(color).not.toBe('undefined');
  });

  it('returns text-emerald-500 for transcript-source events', () => {
    const event = makeEvent({ source: 'transcript', event_type: 'tool_result' });
    expect(getEventColor(event)).toBe('text-emerald-500');
  });
});

describe('getOneLiner', () => {
  it('returns tool_name from top-level event.tool_name for transcript events', () => {
    const event = makeEvent({
      source: 'transcript',
      tool_name: 'Read',
      tool_input: { file_path: '/foo.ts' },
    });
    expect(getOneLiner(event)).toBe('Read');
  });

  it('falls back to hook_data path for sniffer events', () => {
    const event = makeEvent({
      source: 'sniffer',
      hook_data: { tool_name: 'Bash', tool_input: { command: 'ls -la' } },
    });
    const result = getOneLiner(event);
    expect(result).toContain('Bash');
  });
});
