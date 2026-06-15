/**
 * Popout handoff protocol (docs/tab-management.md Part 3 §8): the win/ window
 * announces readiness on BroadcastChannel('flowpad-win-ready'); the origin
 * waits for the matching key (or the 10s UX fallback) before detaching.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BroadcastChannel as NodeBroadcastChannel } from 'node:worker_threads';
import {
  announceWinReady,
  waitForWinReady,
  WIN_READY_TIMEOUT_MS,
} from '@src/tabs/popout-handoff';

// jsdom does not implement BroadcastChannel; Node's worker_threads
// implementation is same-process API-compatible (postMessage/onmessage/close).
const hadNative = typeof globalThis.BroadcastChannel !== 'undefined';
if (!hadNative) {
  (globalThis as Record<string, unknown>).BroadcastChannel = NodeBroadcastChannel;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('popout handoff (Part 3 §8)', () => {
  it('announce → wait round-trip resolves true on a matching key', async () => {
    const waiter = waitForWinReady('agentic_process-abc');
    announceWinReady('agentic_process-abc');
    await expect(waiter).resolves.toBe(true);
  });

  it('ignores announces for other keys until the matching one arrives', async () => {
    const waiter = waitForWinReady('shell-target');
    announceWinReady('shell-other');
    announceWinReady('shell-target');
    await expect(waiter).resolves.toBe(true);
  });

  it('announce without any waiter is a no-op (deep-linked win window)', () => {
    expect(() => announceWinReady('shell-lonely')).not.toThrow();
  });

  it('resolves false on timeout without a matching announce', async () => {
    vi.useFakeTimers();
    const waiter = waitForWinReady('never-announced');
    vi.advanceTimersByTime(WIN_READY_TIMEOUT_MS);
    await expect(waiter).resolves.toBe(false);
  });

  it('is a safe no-op when BroadcastChannel is unavailable', async () => {
    const saved = (globalThis as Record<string, unknown>).BroadcastChannel;
    delete (globalThis as Record<string, unknown>).BroadcastChannel;
    try {
      expect(() => announceWinReady('any')).not.toThrow();
      // Nothing to listen on — resolve immediately so the origin still detaches.
      await expect(waitForWinReady('any')).resolves.toBe(false);
    } finally {
      (globalThis as Record<string, unknown>).BroadcastChannel = saved;
    }
  });
});
