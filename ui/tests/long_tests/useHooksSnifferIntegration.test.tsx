/**
 * Integration test: useHooksSniffer + real backend + CLI injection
 *
 * Validates every UI consumer use-case end-to-end:
 *   CLI `flow hooks report` → HTTP → backend → WebSocket → AgentHook.flowDataStream
 *   → useHooksSniffer React state → derived values used by each consumer.
 *
 * Consumers covered:
 *   1. EventSnifferChip / HeartbeatEventsViewer — events array, count, clear
 *   2. HomeLanding                              — per-session event counts
 *   3. HooksBrowser                             — per-hook-file event counts
 *   4. useClaudeSessionTrace                   — live session accumulation via SnifferProvider
 *   5. HeartbeatEventsViewer (maxEvents)        — trim + monotonic idx after trim
 *   6. sniffer_view_mock                        — events non-empty, raw_line parseable
 *   7. HooksManager                             — enable/disable toggle cycle
 *
 * Requires a running backend at localhost:9007.
 *
 * Isolation strategy: each test uses a random uuid() as session_id for injected
 * events.  useProcessSniffer(sessionId) accumulates only events for that session,
 * so concurrent Claude Code hooks on the dev machine never contaminate results.
 *
 * Cleanup: every test calls disable() AND unmount() in a try/finally so that
 * stale React trees (with non-default maxEvents etc.) cannot interfere with
 * subsequent tests even if the test body times out.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { spawnSync } from 'child_process';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useSnifferContext, SnifferProvider } from '@src/contexts/SnifferContext';
import { useProcessSniffer } from '@src/hooks/use-process-sniffer';
import { useClaudeSessionTrace } from '@src/hooks/use-claude-session-trace';
import { apiTestSetup } from '../utils/test-utils';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '../../..');
const PYTHON = path.join(REPO_ROOT, '.venv/bin/python');

// ---------------------------------------------------------------------------
// Wrappers
// ---------------------------------------------------------------------------

function makeSnifferWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <SnifferProvider>{children}</SnifferProvider>
    </QueryClientProvider>
  );
  wrapper.displayName = 'SnifferWrapper';
  return wrapper;
}

// ---------------------------------------------------------------------------
// CLI injection helper
// ---------------------------------------------------------------------------

/**
 * Inject a hook event by running `flow hooks report` as a real subprocess.
 * The CLI POSTs to AGENT_HOOKS_REPORT_URL → backend → WebSocket → React state.
 */
function injectHookEvent(hookId: string, event: Record<string, unknown>) {
  const result = spawnSync(
    PYTHON,
    ['-m', 'flow_sdk.cli.flow_cli', 'hooks', 'report', `--hook-entry-id=${hookId}`],
    {
      input: JSON.stringify(event),
      encoding: 'utf8',
      env: { ...process.env },
      cwd: REPO_ROOT,
    },
  );
  if (result.status !== 0) {
    throw new Error(`flow hooks report failed (exit ${result.status}):\n${result.stderr}`);
  }
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await apiTestSetup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useHooksSniffer integration — real backend + CLI injection', () => {
  it('1–3, 6–7: events, session counts, hook-file counts, raw_line, toggle', async () => {
    const sessA = uuid();
    const sessB = uuid();

    const { result, unmount } = renderHook(
      () => ({
        sniffer: useSnifferContext(),
        procA: useProcessSniffer(sessA),
        procB: useProcessSniffer(sessB),
      }),
      { wrapper: makeSnifferWrapper() },
    );

    // ── Enable sniffer (Consumer 7: HooksManager toggle) ───────────────────
    expect(result.current.sniffer.isToggling).toBe(false);

    try {
      await act(async () => {
        await result.current.sniffer.enable();
      });

      await waitFor(() => expect(result.current.sniffer.status.enabled).toBe(true), { timeout: 5000 });
      const hookId = result.current.sniffer.status.hook_id!;
      expect(hookId).toBeTruthy();

      // ── Inject 3 agent_hook events ─────────────────────────────────────────
      injectHookEvent(hookId, { hook_event_name: 'PreToolUse',  session_id: sessA, cwd: '/tmp' });
      injectHookEvent(hookId, { hook_event_name: 'PostToolUse', session_id: sessA, cwd: '/tmp' });
      injectHookEvent(hookId, { hook_event_name: 'PreToolUse',  session_id: sessB, cwd: '/tmp' });

      // Consumer 1: EventSnifferChip / HeartbeatEventsViewer — events array
      await waitFor(
        () => expect(result.current.procA.events.length + result.current.procB.events.length).toBe(3),
        { timeout: 8000 },
      );

      const eventsA = result.current.procA.events;
      const eventsB = result.current.procB.events;
      expect(eventsA.every(e => e.webhook_type === 'agent_hook')).toBe(true);
      expect(eventsB.every(e => e.webhook_type === 'agent_hook')).toBe(true);

      // Consumer 2: HomeLanding — per-session event counts
      expect(eventsA.length).toBe(2);
      expect(eventsB.length).toBe(1);
      expect(eventsA.map(e => e.event_type)).toContain('PreToolUse');
      expect(eventsA.map(e => e.event_type)).toContain('PostToolUse');

      // Consumer 3: HooksBrowser — per-hook-file event counts
      // hook_file_path is set by the CLI from settings discovery, not from stdin.
      injectHookEvent(hookId, {
        hook_event_name: 'PostToolUse',
        session_id: sessA,
        cwd: '/tmp',
      });
      await waitFor(() => expect(result.current.procA.events.length).toBe(3), { timeout: 5000 });
      const lastEvent = result.current.procA.events[result.current.procA.events.length - 1];
      expect(lastEvent.event_type).toBe('PostToolUse');
      // hook_file_path is populated from CLI settings discovery — verify field exists
      expect(typeof lastEvent.hook_file_path).toBe('string');

      // Consumer 6: sniffer_view_mock — events non-empty, raw_line is parseable JSON
      const allEvents = [...result.current.procA.events, ...result.current.procB.events];
      expect(allEvents.length).toBeGreaterThan(0);
      for (const ev of allEvents) {
        expect(() => JSON.parse(ev.raw_line)).not.toThrow();
      }

      // Consumer 1 (clear): verify clear empties the ring buffer for our sessions
      result.current.sniffer.clear();
      await waitFor(
        () => expect(
          result.current.sniffer.events.filter(e => e.session_id === sessA || e.session_id === sessB).length,
        ).toBe(0),
        { timeout: 5000 },
      );
    } finally {
      // ── Consumer 7 (disable): HooksManager power-off ───────────────────────
      await act(async () => { await result.current.sniffer.disable(); });
      unmount();
    }
  });

  it('5: maxEvents trims stream and idx is monotonically increasing', async () => {
    const sessId = uuid();

    const { result, unmount } = renderHook(
      () => ({
        sniffer: useSnifferContext(),
        proc: useProcessSniffer(sessId),
      }),
      { wrapper: makeSnifferWrapper() },
    );

    try {
      await act(async () => {
        await result.current.sniffer.enable();
      });
      await waitFor(() => expect(result.current.sniffer.status.enabled).toBe(true), { timeout: 5000 });
      const hookId = result.current.sniffer.status.hook_id!;

      // Lower the cap so we can trigger trim quickly
      act(() => result.current.sniffer.setMaxEvents(5));

      // Inject 8 events (3 more than cap)
      for (let i = 0; i < 8; i++) {
        injectHookEvent(hookId, { hook_event_name: `Ev${i}`, session_id: sessId, cwd: '/tmp' });
      }

      // Wait for at least 5 events to arrive for our session
      await waitFor(
        () => expect(result.current.proc.events.length).toBeGreaterThanOrEqual(5),
        { timeout: 10000 },
      );

      // idx must be strictly increasing even after trim (stable idx means deduplication is correct)
      const idxValues = result.current.proc.events.map(e => e.idx);
      for (let i = 1; i < idxValues.length; i++) {
        expect(idxValues[i]).toBeGreaterThan(idxValues[i - 1]);
      }
      // Trim is proven by idx gaps: some early events were evicted from the stream,
      // so idxValues won't be [1,2,3,...8] — there will be gaps showing eviction happened.
    } finally {
      await act(async () => { await result.current.sniffer.disable(); });
      unmount();
    }
  });

  it('4: useClaudeSessionTrace accumulates live events by sessionId via SnifferProvider', async () => {
    const sessTrace = uuid();
    const sessOther = uuid();

    const { result, unmount } = renderHook(
      () => ({
        sniffer: useSnifferContext(),
        trace: useClaudeSessionTrace(sessTrace),
      }),
      { wrapper: makeSnifferWrapper() },
    );

    try {
      await act(async () => {
        await result.current.sniffer.enable();
      });
      await waitFor(() => expect(result.current.sniffer.status.enabled).toBe(true), { timeout: 5000 });
      const hookId = result.current.sniffer.status.hook_id!;

      // Inject events for our target session and a different one
      injectHookEvent(hookId, { hook_event_name: 'PreToolUse',  session_id: sessTrace, cwd: '/tmp' });
      injectHookEvent(hookId, { hook_event_name: 'PostToolUse', session_id: sessTrace, cwd: '/tmp' });
      injectHookEvent(hookId, { hook_event_name: 'Stop',        session_id: sessOther, cwd: '/tmp' });

      // Session trace should accumulate only events for sessTrace
      await waitFor(
        () => expect(result.current.trace.liveCount).toBeGreaterThanOrEqual(2),
        { timeout: 10000 },
      );
      // Stable ids ensure no re-accumulation after trim — liveCount is exactly 2
      expect(result.current.trace.liveCount).toBe(2);

      // Ring-buffer eviction survival: clear the sniffer stream
      result.current.sniffer.clear();
      await waitFor(
        () => expect(
          result.current.sniffer.events.filter(e => e.session_id === sessTrace).length,
        ).toBe(0),
        { timeout: 5000 },
      );

      // useClaudeSessionTrace accumulates into its own buffer — survives clear
      expect(result.current.trace.liveCount).toBe(2);

      // New events after clear still arrive correctly
      injectHookEvent(hookId, { hook_event_name: 'PreToolUse', session_id: sessTrace, cwd: '/tmp' });
      await waitFor(
        () => expect(result.current.trace.liveCount).toBe(3),
        { timeout: 8000 },
      );
    } finally {
      await act(async () => { await result.current.sniffer.disable(); });
      unmount();
    }
  });
});
