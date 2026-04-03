import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AgentHook, dataContext, FlowData, snifferManager } from '@sdk';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { useHooksSniffer } from '@src/hooks/use-hooks-sniffer';
import { unitTestSetup } from '../../../utils/test-utils';
import { v4 as uuid } from 'uuid';

// ── MockAgentHook — skips HTTP watch so tests stay unit-level ────────────────
class MockAgentHook extends AgentHook {
  override async watch() {
    return async () => {};
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  wrapper.displayName = 'TestWrapper';
  return wrapper;
}

/** Push a FlowData item directly into the hook entity's stream. */
function pushAgentHook(hook: AgentHook, hookEventName: string, extra: object = {}) {
  const payload = {
    webhook_type: 'agent_hook',
    hook_entry_id: uuid(),
    hook_data: {
      hook_event_name: hookEventName,
      raw_hook_data: { session_id: 'sess-test', hook_event_name: hookEventName },
    },
    ...extra,
  };
  const fd = new FlowData('message', JSON.stringify(payload), {
    webhook_type: 'agent_hook',
    t: new Date().toISOString(),
  });
  hook.handleFlowData(fd);
}

/** Push a transcript_entry FlowData item with the given tools. */
function pushTranscriptEntry(hook: AgentHook, tools: { name: string }[]) {
  const payload = {
    entry: { type: 'assistant', tools },
    session_id: 'sess-test',
    transcript_path: '',
  };
  const fd = new FlowData('message', JSON.stringify(payload), {
    t: new Date().toISOString(),
  });
  hook.handleFlowData(fd);
}

/** Push a hook_op FlowData item (uses attributes.webhook_type, not payload field). */
function pushHookOp(hook: AgentHook, eventName: string) {
  const payload = {
    type: 'resource',
    operation: 'create',
    data: { event_name: eventName },
  };
  const fd = new FlowData('message', JSON.stringify(payload), {
    webhook_type: 'hook_op',
    t: new Date().toISOString(),
  });
  hook.handleFlowData(fd);
}

// ── Setup / Teardown ─────────────────────────────────────────────────────────

let mockHook: MockAgentHook;

beforeEach(async () => {
  await unitTestSetup();

  mockHook = new MockAgentHook({ id: uuid(), name: 'test-hook' });
  await snifferManager.attach(mockHook);   // registers in cache, mock watch is no-op
  dataContext.setSnifferEnabled(true);
});

afterEach(() => {
  (snifferManager as any)._entity = null;
  (snifferManager as any)._unwatch = null;
  dataContext.setSnifferEnabled(false);
  dataContext.setSnifferHook(null);
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('useHooksSniffer stream lifecycle', () => {
  it('emit: pushing a FlowData item produces a SnifferEvent', async () => {
    const { result } = renderHook(() => useHooksSniffer(), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.events.length).toBe(0));

    pushAgentHook(mockHook, 'PreToolUse');

    await waitFor(() => expect(result.current.events.length).toBe(1));
    expect(result.current.events[0].event_type).toBe('PreToolUse');
    expect(result.current.events[0].webhook_type).toBe('agent_hook');
  });

  it('clear: stream.clear() empties events in all consumers', async () => {
    const { result } = renderHook(() => useHooksSniffer(), { wrapper: makeWrapper() });

    pushAgentHook(mockHook, 'PreToolUse');
    pushAgentHook(mockHook, 'PostToolUse');
    pushAgentHook(mockHook, 'Stop');

    await waitFor(() => expect(result.current.events.length).toBe(3));

    // Clear propagates through stream → useEntityData → React state
    mockHook.flowDataStream.clear();

    await waitFor(() => expect(result.current.events.length).toBe(0));
  });

  it('fan-out: transcript_entry with N tools produces N SnifferEvents', async () => {
    const { result } = renderHook(() => useHooksSniffer(), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.events.length).toBe(0));

    pushTranscriptEntry(mockHook, [{ name: 'Bash' }, { name: 'Read' }, { name: 'Write' }]);

    await waitFor(() => expect(result.current.events.length).toBe(3));
    result.current.events.forEach((e) => {
      expect(e.webhook_type).toBe('transcript_entry');
    });
    expect(result.current.events.map((e) => e.event_type)).toEqual(['Bash', 'Read', 'Write']);
  });

  it('events generation: agent_hook maps hook_event_name to event_type', async () => {
    const { result } = renderHook(() => useHooksSniffer(), { wrapper: makeWrapper() });

    pushAgentHook(mockHook, 'PostToolUse');

    await waitFor(() => expect(result.current.events.length).toBe(1));
    expect(result.current.events[0].event_type).toBe('PostToolUse');
    expect(result.current.events[0].layer).toBe('debug');
  });

  it('events generation: hook_op maps data.event_name to event_type', async () => {
    const { result } = renderHook(() => useHooksSniffer(), { wrapper: makeWrapper() });

    pushHookOp(mockHook, 'crud:create');

    await waitFor(() => expect(result.current.events.length).toBe(1));
    expect(result.current.events[0].event_type).toBe('crud:create');
    expect(result.current.events[0].webhook_type).toBe('hook_op');
  });

  it('maxEvents trim: _ownItems is capped to maxEvents after trim effect', async () => {
    const { result } = renderHook(() => useHooksSniffer(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.maxEvents).toBe(100));

    // Push maxEvents + 10 items
    for (let i = 0; i < 110; i++) {
      pushAgentHook(mockHook, `Event${i}`);
    }

    await waitFor(() => {
      const ownItems = (mockHook.flowDataStream as any)._ownItems;
      expect(ownItems.length).toBeLessThanOrEqual(100);
    });
  });

  it('globalIndexOffset: idx is monotonically increasing after trim', async () => {
    const { result } = renderHook(() => useHooksSniffer(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.maxEvents).toBe(100));

    // Push enough to trigger at least one trim
    for (let i = 0; i < 110; i++) {
      pushAgentHook(mockHook, `Event${i}`);
    }

    await waitFor(() => expect(result.current.events.length).toBeGreaterThan(0));

    // idx values must be strictly increasing — no duplicates, no gaps going backwards
    const idxValues = result.current.events.map((e) => e.idx);
    for (let i = 1; i < idxValues.length; i++) {
      expect(idxValues[i]).toBeGreaterThan(idxValues[i - 1]);
    }
    // The stream should have been trimmed to at most maxEvents items
    const ownItems = (mockHook.flowDataStream as any)._ownItems;
    expect(ownItems.length).toBeLessThanOrEqual(100);
    // Note: the offset ref updates after render so idx[0] may still be 1 until
    // the next incoming event — this is a known trim-staleness characteristic.
  });

  it('clear() resets globalIndexOffset', async () => {
    const { result } = renderHook(() => useHooksSniffer(), { wrapper: makeWrapper() });

    for (let i = 0; i < 5; i++) pushAgentHook(mockHook, `Event${i}`);
    await waitFor(() => expect(result.current.events.length).toBe(5));

    result.current.clear();
    await waitFor(() => expect(result.current.events.length).toBe(0));

    // After clear, new events should start from idx 1 again
    pushAgentHook(mockHook, 'AfterClear');
    await waitFor(() => expect(result.current.events.length).toBe(1));
    expect(result.current.events[0].idx).toBe(1);
  });
});
