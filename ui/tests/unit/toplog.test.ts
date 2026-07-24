import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import apiClient from '@sdk/client';
import { toplog } from '@sdk';

// Spy on the real apiClient singleton (toplog imports the same instance) so
// on/off/enable/disable never hit a backend.
const mockPost = vi.spyOn(apiClient, 'post');
const mockGet = vi.spyOn(apiClient, 'get');

type State = { enabled: boolean; filter: Record<string, boolean> };

/** Force the singleton's in-memory state (bypasses the backend round-trip). */
function setState(state: State) {
  (toplog as any)._apply(state);
}

describe('toplog (frontend)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    setState({ enabled: false, filter: {} });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
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
    expect(toplog.state()).toEqual({ enabled: true, filter: { a: true, b: true } });
  });
});
