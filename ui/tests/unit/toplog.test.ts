import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import apiClient from '@sdk/client';
import { ConnectionManager, toplog } from '@sdk';
import { markHubModeReady } from '@sdk/utils/hub-runtime';

// Spy on the real apiClient singleton (toplog imports the same instance) so
// on/off/enable/disable never hit a backend.
const mockPost = vi.spyOn(apiClient, 'post');
const mockGet = vi.spyOn(apiClient, 'get');

type State = { enabled: boolean; filter: Record<string, boolean>; persist?: boolean };

/** Force the singleton's in-memory state (bypasses the backend round-trip). */
function setState(state: State) {
  (toplog as any)._apply(state);
}

/** Drop any queued client-log lines and the pending flush timer. */
function resetQueue() {
  const t = toplog as any;
  if (t._flushTimer !== null) clearTimeout(t._flushTimer);
  t._flushTimer = null;
  t._queue = [];
  t._dropped = 0;
}

describe('toplog (frontend)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPost.mockResolvedValue(undefined);
    resetQueue();
    setState({ enabled: false, filter: {} });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    resetQueue();
    vi.useRealTimers();
  });

  it('defaults to everything off', () => {
    expect(toplog.enabled).toBe(false);
    expect(toplog.isOn('pty')).toBe(false);
  });

  it('log is a no-op when the master switch is off', () => {
    setState({ enabled: false, filter: { pty: true } });
    toplog.log('pty', 'should not emit');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('log emits to console when the tag is active', () => {
    setState({ enabled: true, filter: { pty: true } });
    toplog.log('pty', 'hello');
    expect(logSpy).toHaveBeenCalledWith('[toplog:pty]', 'hello');
  });

  it('OR semantics — emits if any listed tag is on, prefixing only active ones', () => {
    setState({ enabled: true, filter: { sync: true } });
    toplog.log(['pty', 'sync'], 'multi');
    expect(logSpy).toHaveBeenCalledWith('[toplog:sync]', 'multi');
  });

  it('OR semantics — no-op when none of the listed tags are on', () => {
    setState({ enabled: true, filter: { other: true } });
    toplog.log(['pty', 'sync'], 'multi');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('isOn respects the master switch', () => {
    setState({ enabled: true, filter: { pty: true } });
    expect(toplog.isOn('pty')).toBe(true);
    setState({ enabled: false, filter: { pty: true } });
    expect(toplog.isOn('pty')).toBe(false);
  });

  it('on() posts to /toplog/on and mirrors the returned state', async () => {
    mockPost.mockResolvedValueOnce({ enabled: true, filter: { pty: true } });
    await toplog.on('pty');
    expect(mockPost).toHaveBeenCalledWith('/toplog/on', { tags: ['pty'] });
    expect(toplog.isOn('pty')).toBe(true);
  });

  it('off() posts to /toplog/off with the tags', async () => {
    mockPost.mockResolvedValueOnce({ enabled: true, filter: {} });
    await toplog.off('pty');
    expect(mockPost).toHaveBeenCalledWith('/toplog/off', { tags: ['pty'] });
    expect(toplog.isOn('pty')).toBe(false);
  });

  it('enable() / disable() post to the right routes and mirror state', async () => {
    mockPost.mockResolvedValueOnce({ enabled: true, filter: {} });
    await toplog.enable();
    expect(mockPost).toHaveBeenCalledWith('/toplog/enable', {});
    expect(toplog.enabled).toBe(true);

    mockPost.mockResolvedValueOnce({ enabled: false, filter: {} });
    await toplog.disable();
    expect(mockPost).toHaveBeenCalledWith('/toplog/disable', {});
    expect(toplog.enabled).toBe(false);
  });

  it('state() reflects the active tags', () => {
    setState({ enabled: true, filter: { a: true, b: true } });
    expect(toplog.state()).toEqual({ enabled: true, filter: { a: true, b: true }, persist: false });
  });

  it('persist() posts to /toplog/persist and mirrors the flag', async () => {
    mockPost.mockResolvedValueOnce({ enabled: true, filter: { pty: true }, persist: true });
    await toplog.persist();
    expect(mockPost).toHaveBeenCalledWith('/toplog/persist', { persist: true });
    expect(toplog.state().persist).toBe(true);
  });

  it('forwards logged lines to /toplog/client-log in one batch per second', async () => {
    vi.useFakeTimers();
    setState({ enabled: true, filter: { pty: true } });
    toplog.log('pty', 'first', { chunks: 3 });
    toplog.log('pty', 'second');
    toplog.log('other', 'not active');
    expect(mockPost).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(mockPost).toHaveBeenCalledTimes(1);
    const [route, body] = mockPost.mock.calls[0] as [string, { lines: { tags: string[]; msg: string }[] }];
    expect(route).toBe('/toplog/client-log');
    expect(body.lines.map((l) => [l.tags, l.msg])).toEqual([
      [['pty'], 'first {"chunks":3}'],
      [['pty'], 'second'],
    ]);
  });

  it('caps the queue and reports the dropped count', async () => {
    vi.useFakeTimers();
    setState({ enabled: true, filter: { pty: true } });
    for (let i = 0; i < 510; i++) toplog.log('pty', `line ${i}`);
    await vi.advanceTimersByTimeAsync(1000);
    const body = mockPost.mock.calls[0][1] as { lines: { msg: string }[] };
    expect(body.lines).toHaveLength(501);
    expect(body.lines[500].msg).toBe('toplog client queue overflow: 10 lines dropped');
  });

  it('re-seeds from /toplog/state when the socket reconnects (backend restart reset)', async () => {
    const handlers: Record<string, () => void> = {};
    vi.spyOn(ConnectionManager, 'getInstance').mockReturnValue({
      on: (event: string, fn: () => void) => {
        handlers[event] = fn;
      },
    } as any);
    markHubModeReady(); // no bootstrap in a unit test — unblock the desk-mode seed
    const t = toplog as any;
    t._initialized = false;
    mockGet.mockResolvedValueOnce({ enabled: true, filter: { pty: true } });
    await toplog.bootstrap();
    expect(toplog.isOn('pty')).toBe(true);

    // The backend restarted and reset its file; the reconnect must pick that up.
    mockGet.mockResolvedValueOnce({ enabled: false, filter: {} });
    handlers.on_reconnected();
    await vi.waitFor(() => expect(toplog.isOn('pty')).toBe(false));
    t._initialized = false;
  });
});
