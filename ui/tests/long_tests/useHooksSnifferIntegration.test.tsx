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
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { spawnSync } from 'child_process';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useHooksSniffer } from '@src/hooks/use-hooks-sniffer';
import { useClaudeSessionTrace } from '@src/hooks/use-claude-session-trace';
import { SnifferProvider, useSnifferContext } from '@src/contexts/SnifferContext';
import { snifferManager } from '@sdk';
import { apiTestSetup } from '../utils/test-utils';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '../../..');
const PYTHON = path.join(REPO_ROOT, '.venv/bin/python');

// ---------------------------------------------------------------------------
// Wrappers
// ---------------------------------------------------------------------------

function makeQueryWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  wrapper.displayName = 'QueryWrapper';
  return wrapper;
}

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
    const { result } = renderHook(() => useHooksSniffer(), { wrapper: makeQueryWrapper() });

    // ── Enable sniffer (Consumer 7: HooksManager toggle) ───────────────────
    expect(result.current.isToggling).toBe(false);

    await act(async () => {
      await result.current.enable();
    });

    await waitFor(() => expect(result.current.status.enabled).toBe(true), { timeout: 5000 });
    const hookId = result.current.status.hook_id!;
    expect(hookId).toBeTruthy();

    // ── Inject 3 agent_hook events ─────────────────────────────────────────
    injectHookEvent(hookId, { hook_event_name: 'PreToolUse',  session_id: 'sess-A', cwd: '/tmp' });
    injectHookEvent(hookId, { hook_event_name: 'PostToolUse', session_id: 'sess-A', cwd: '/tmp' });
    injectHookEvent(hookId, { hook_event_name: 'PreToolUse',  session_id: 'sess-B', cwd: '/tmp' });

    // Consumer 1: EventSnifferChip / HeartbeatEventsViewer — events array
    await waitFor(() => expect(result.current.events.length).toBe(3), { timeout: 8000 });

    const events = result.current.events;
    expect(events.every(e => e.webhook_type === 'agent_hook')).toBe(true);
    expect(events.map(e => e.event_type)).toContain('PreToolUse');
    expect(events.map(e => e.event_type)).toContain('PostToolUse');

    // Consumer 2: HomeLanding — per-session event counts
    const sessACnt = events.filter(e => e.session_id === 'sess-A').length;
    const sessBCnt = events.filter(e => e.session_id === 'sess-B').length;
    expect(sessACnt).toBe(2);
    expect(sessBCnt).toBe(1);

    // Consumer 3: HooksBrowser — per-hook-file event counts
    // hook_file_path is set by the CLI from settings discovery, not from stdin.
    injectHookEvent(hookId, {
      hook_event_name: 'PostToolUse',
      session_id: 'sess-A',
      cwd: '/tmp',
    });
    await waitFor(() => expect(result.current.events.length).toBe(4), { timeout: 5000 });
    const lastEvent = result.current.events[result.current.events.length - 1];
    expect(lastEvent.event_type).toBe('PostToolUse');
    // hook_file_path is populated from CLI settings discovery — verify field exists
    expect(typeof lastEvent.hook_file_path).toBe('string');

    // Consumer 6: sniffer_view_mock — events non-empty, raw_line is parseable JSON
    expect(result.current.events.length).toBeGreaterThan(0);
    for (const ev of result.current.events) {
      expect(() => JSON.parse(ev.raw_line)).not.toThrow();
    }

    // ── Consumer 1 (clear): EventSnifferChip clear button ──────────────────
    result.current.clear();
    await waitFor(() => expect(result.current.events.length).toBe(0), { timeout: 5000 });

    // ── Consumer 7 (disable): HooksManager power-off ───────────────────────
    await act(async () => {
      await result.current.disable();
    });
    await waitFor(() => expect(result.current.status.enabled).toBe(false), { timeout: 5000 });
  });

  it('5: maxEvents trims stream and idx is monotonically increasing', async () => {
    const { result } = renderHook(() => useHooksSniffer(), { wrapper: makeQueryWrapper() });

    await act(async () => {
      await result.current.enable();
    });
    await waitFor(() => expect(result.current.status.enabled).toBe(true), { timeout: 5000 });
    const hookId = result.current.status.hook_id!;

    // Lower the cap so we can trigger trim quickly
    act(() => result.current.setMaxEvents(5));

    // Inject 8 events (3 more than cap)
    for (let i = 0; i < 8; i++) {
      injectHookEvent(hookId, { hook_event_name: `Ev${i}`, session_id: 'sess-trim', cwd: '/tmp' });
    }

    await waitFor(
      () => expect(result.current.events.length).toBeGreaterThan(0),
      { timeout: 10000 },
    );
    await waitFor(
      () => expect(result.current.events.length).toBeLessThanOrEqual(5),
      { timeout: 10000 },
    );

    // idx must be strictly increasing even after trim
    const idxValues = result.current.events.map(e => e.idx);
    for (let i = 1; i < idxValues.length; i++) {
      expect(idxValues[i]).toBeGreaterThan(idxValues[i - 1]);
    }

    // Cleanup
    result.current.clear();
    await act(async () => { await result.current.disable(); });
  });

  it('4: useClaudeSessionTrace accumulates live events by sessionId via SnifferProvider', async () => {
    const wrapper = makeSnifferWrapper();

    // Render the sniffer context first and enable it
    const snifferHook = renderHook(() => useSnifferContext(), { wrapper });
    await act(async () => {
      await snifferHook.result.current.enable();
    });
    await waitFor(() => expect(snifferHook.result.current.status.enabled).toBe(true), { timeout: 5000 });
    const hookId = snifferHook.result.current.status.hook_id!;

    // Render the session trace hook in the same provider tree
    const traceHook = renderHook(
      () => useClaudeSessionTrace('sess-trace'),
      { wrapper },
    );

    // Inject events for our target session and a different one
    injectHookEvent(hookId, { hook_event_name: 'PreToolUse',  session_id: 'sess-trace', cwd: '/tmp' });
    injectHookEvent(hookId, { hook_event_name: 'PostToolUse', session_id: 'sess-trace', cwd: '/tmp' });
    injectHookEvent(hookId, { hook_event_name: 'Stop',        session_id: 'sess-other', cwd: '/tmp' });

    // Session trace should accumulate only events for 'sess-trace'
    await waitFor(
      () => expect(traceHook.result.current.liveCount).toBeGreaterThanOrEqual(2),
      { timeout: 10000 },
    );
    expect(traceHook.result.current.liveCount).toBe(2);

    // Ring-buffer eviction survival: clear the sniffer stream
    snifferHook.result.current.clear();
    await waitFor(
      () => expect(snifferHook.result.current.events.length).toBe(0),
      { timeout: 5000 },
    );

    // useClaudeSessionTrace accumulates into its own buffer — survives clear
    expect(traceHook.result.current.liveCount).toBe(2);

    // New events after clear still arrive correctly
    injectHookEvent(hookId, { hook_event_name: 'PreToolUse', session_id: 'sess-trace', cwd: '/tmp' });
    await waitFor(
      () => expect(traceHook.result.current.liveCount).toBe(3),
      { timeout: 8000 },
    );

    // Cleanup
    await act(async () => { await snifferHook.result.current.disable(); });
  });
});
