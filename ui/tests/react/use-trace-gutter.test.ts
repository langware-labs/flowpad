import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useTraceGutter } from '@src/components/terminal/interactive-terminal/use-trace-gutter';

// Mock the new unified hook
vi.mock('@src/hooks/use-claude-session-trace', () => ({
  useClaudeSessionTrace: vi.fn(() => ({
    events: [],
    isLoading: false,
    historicalCount: 0,
    liveCount: 0,
    sessionStartTime: null,
  })),
}));

import { useClaudeSessionTrace } from '@src/hooks/use-claude-session-trace';

// mockAdapter acts as a minimal PtySyncSession with bucketTimestamp returning row 10
const mockAdapter = {
  bucketTimestamp: (_ts: number) => 10,
  getScrollState: () => ({ baseY: 0, cursorY: 10 }),
  getEvictionOffset: () => 0,
} as any;

describe('useTraceGutter', () => {
  beforeEach(() => {
    vi.mocked(useClaudeSessionTrace).mockReturnValue({
      events: [],
      isLoading: false,
      historicalCount: 0,
      liveCount: 0,
      sessionStartTime: null,
    });
  });

  it('returns empty entries when no adapter', () => {
    const { result } = renderHook(() => useTraceGutter('sess-1', true, null, false, 0));
    expect(result.current.entries).toEqual([]);
    expect(result.current.totalTraceEvents).toBe(0);
  });

  it('maps sniffer events to TraceGutterEntry with absRow', async () => {
    vi.mocked(useClaudeSessionTrace).mockReturnValue({
      events: [{
        id: 'ev-1',
        idx: 1,
        timestamp: '2026-03-08T00:00:01Z',
        source: 'sniffer',
        session_id: 'sess-1',
        event_type: 'PreToolUse',
        raw: {},
        webhook_type: 'agent_hook',
        layer: 'debug',
      }],
      isLoading: false,
      historicalCount: 0,
      liveCount: 1,
      sessionStartTime: null,
    });

    const { result, rerender } = renderHook(() => useTraceGutter('sess-1', true, mockAdapter, false, 0));
    // The useEffect that captures absRow runs after render; trigger a re-render
    await act(async () => { rerender(); });
    await waitFor(() => {
      expect(result.current.entries.length).toBe(1);
    });
    expect(result.current.entries[0].absRow).toBe(10); // bucketTimestamp returns 10
    expect(result.current.entries[0].event.source).toBe('sniffer');
  });

  it('maps transcript entries to TraceGutterEntry with absRow=null', () => {
    vi.mocked(useClaudeSessionTrace).mockReturnValue({
      events: [{
        id: 'transcript-uuid-1',
        timestamp: '2026-03-08T00:00:00Z',
        source: 'transcript',
        session_id: 'sess-1',
        event_type: 'UserMessage',
        summary: 'hi',
        raw: { entry_type: 'user', entry_uuid: 'uuid-1' },
      }],
      isLoading: false,
      historicalCount: 1,
      liveCount: 0,
      sessionStartTime: null,
    });

    const { result } = renderHook(() => useTraceGutter('sess-1', true, mockAdapter, false, 0));
    expect(result.current.historicalCount).toBe(1);
    expect(result.current.entries[0].absRow).toBeNull();
    expect(result.current.entries[0].event.source).toBe('transcript');
  });

  it('merges and sorts by timestamp', async () => {
    vi.mocked(useClaudeSessionTrace).mockReturnValue({
      events: [
        {
          id: 'transcript-uuid-1',
          timestamp: '2026-03-08T00:00:01Z',
          source: 'transcript',
          session_id: 'sess-1',
          event_type: 'UserMessage',
          raw: {},
        },
        {
          id: 'ev-1',
          idx: 1,
          timestamp: '2026-03-08T00:00:02Z',
          source: 'sniffer',
          session_id: 'sess-1',
          event_type: 'PreToolUse',
          raw: {},
          webhook_type: 'agent_hook',
          layer: 'debug',
        },
      ],
      isLoading: false,
      historicalCount: 1,
      liveCount: 1,
      sessionStartTime: null,
    });

    const { result, rerender } = renderHook(() => useTraceGutter('sess-1', true, mockAdapter, false, 0));
    // The useEffect that captures absRow runs after render; trigger a re-render
    await act(async () => { rerender(); });
    await waitFor(() => {
      expect(result.current.totalTraceEvents).toBe(2);
    });
    // Transcript (00:00:01) should come before sniffer (00:00:02)
    expect(result.current.entries[0].event.source).toBe('transcript');
    expect(result.current.entries[1].event.source).toBe('sniffer');
  });

  it('duplicate event ids produce only one entry', async () => {
    const event = {
      id: 'dup-1',
      idx: 0,
      timestamp: '2026-03-08T00:00:01Z',
      source: 'sniffer' as const,
      session_id: 'sess-1',
      event_type: 'PreToolUse',
      raw: {},
      webhook_type: 'agent_hook',
      layer: 'debug' as const,
    };
    vi.mocked(useClaudeSessionTrace).mockReturnValue({
      events: [event, event],  // same object twice
      isLoading: false,
      historicalCount: 0,
      liveCount: 2,
      sessionStartTime: null,
    });

    const { result, rerender } = renderHook(() => useTraceGutter('sess-1', true, mockAdapter, false, 0));
    await act(async () => { rerender(); });
    await waitFor(() => expect(result.current.entries.length).toBeGreaterThanOrEqual(1));
    // Deduplication by id means only 1 entry
    expect(result.current.entries.length).toBe(1);
  });
});
