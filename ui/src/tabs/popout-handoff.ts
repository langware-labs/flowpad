/**
 * Popout handoff protocol (docs/tab-management.md Part 3 §8).
 *
 * Entirely client-side — no backend window registry (a window is a per-client
 * concept and connection ids are reconnect-fragile):
 *
 *   origin: openDockInWindow(pointer)            # win window opens
 *   win:    loaders run → view mounts/attaches   # PTY multi-attach is legal
 *   win:    BroadcastChannel('flowpad-win-ready').postMessage({key})
 *   origin: on matching key → navigate away via resolveActive
 *
 * Deep-linked `win/` URLs (no opener): the announce has no listener — a
 * no-op by construction; the window never blocks on an acknowledgment.
 */

/** BroadcastChannel name shared by the origin window and the win/ window. */
export const WIN_READY_CHANNEL = 'flowpad-win-ready';

/**
 * UX fallback (NOT a correctness wait — do not poll, do not raise): if the
 * win window never loads (blocked popup, crashed tab, slow machine), the
 * origin still detaches after this long so the popout gesture completes.
 * A matching ready signal resolves the wait immediately; this cap only
 * bounds the no-signal case.
 */
export const WIN_READY_TIMEOUT_MS = 10_000;

interface WinReadyMessage {
  key?: string;
}

/**
 * Announce (fire-and-forget) that a win/ window has mounted the view for
 * `pointerKey`. No-op when BroadcastChannel is unavailable; never throws.
 */
export function announceWinReady(pointerKey: string): void {
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    const channel = new BroadcastChannel(WIN_READY_CHANNEL);
    channel.postMessage({ key: pointerKey } satisfies WinReadyMessage);
    channel.close();
  } catch {
    // Fire-and-forget: a failed announce only means the origin detaches on
    // the timeout fallback instead of immediately.
  }
}

/**
 * Wait for a win/ window to announce readiness for `pointerKey`.
 * Resolves `true` on a matching announce, `false` on timeout (or when
 * BroadcastChannel is unavailable — then there is nothing to wait for).
 * Always cleans up the channel and the timer.
 */
export function waitForWinReady(
  pointerKey: string,
  timeoutMs: number = WIN_READY_TIMEOUT_MS,
): Promise<boolean> {
  if (typeof BroadcastChannel === 'undefined') return Promise.resolve(false);

  let channel: BroadcastChannel;
  try {
    channel = new BroadcastChannel(WIN_READY_CHANNEL);
  } catch {
    return Promise.resolve(false);
  }

  return new Promise<boolean>((resolve) => {
    const settle = (ready: boolean) => {
      clearTimeout(timer);
      channel.close();
      resolve(ready);
    };
    const timer = setTimeout(() => settle(false), timeoutMs);
    channel.onmessage = (event: MessageEvent) => {
      const data = event.data as WinReadyMessage | null;
      if (data?.key !== pointerKey) return;
      settle(true);
    };
  });
}
