/**
 * `useWebappHealth` is the only browser-side signal that can tell a live web app
 * from a dead one, so its exact semantics are load-bearing for the whole display.
 *
 * The subtlety worth pinning: the ping uses `mode: 'no-cors'`, which resolves to
 * an opaque response for *any* HTTP answer. That means a throw -- and only a
 * throw -- indicates a network-level failure. A 500 resolves and reads as `up`,
 * which is exactly why severity is never derived from this signal alone.
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWebappHealth } from '@src/components/display-toolbar/use-webapp-health';

const HOST = 'http://localhost:6001/api/v1/graph/agentic_process/abc/get-host?port=4173';

describe('useWebappHealth', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Polling is shared per host in a module-level registry and is torn down
    // when the last subscriber unmounts. The unit tier has no automatic RTL
    // cleanup, so without this the watch (and its cached health) leaks into the
    // next test.
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reports down when the fetch throws (nothing listening)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    const { result } = renderHook(() => useWebappHealth(HOST));

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current).toBe('down');
  });

  it('reports up when the fetch resolves', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ status: 0, type: 'opaque' } as Response);
    const { result } = renderHook(() => useWebappHealth(HOST));

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current).toBe('up');
  });

  it('reports up for a 5xx, which is why liveness alone cannot decide severity', async () => {
    // A server that is listening and erroring is indistinguishable from a
    // healthy one here. The backend probe exists to cover this gap.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ status: 500 } as Response);
    const { result } = renderHook(() => useWebappHealth(HOST));

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current).toBe('up');
  });

  it('keeps polling on the interval so a server dying mid-session is noticed', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ status: 200 } as Response);
    const { result } = renderHook(() => useWebappHealth(HOST, 5000));

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current).toBe('up');

    fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(result.current).toBe('down');
  });

  it('polls a host once no matter how many components watch it', async () => {
    // The display and its toolbar LED both watch the same app. One interval
    // each would double the request rate and let the two surfaces disagree
    // about the same URL.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ status: 200 } as Response);
    const first = renderHook(() => useWebappHealth(HOST, 5000));
    const second = renderHook(() => useWebappHealth(HOST, 5000));

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const afterMount = fetchSpy.mock.calls.length;
    expect(afterMount).toBe(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(fetchSpy.mock.calls.length).toBe(afterMount + 1);
    expect(first.result.current).toBe('up');
    expect(second.result.current).toBe('up');
  });

  it('keeps polling for the survivor when one of two watchers unmounts', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ status: 200 } as Response);
    const first = renderHook(() => useWebappHealth(HOST, 5000));
    renderHook(() => useWebappHealth(HOST, 5000));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    first.unmount();
    const afterUnmount = fetchSpy.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(fetchSpy.mock.calls.length).toBe(afterUnmount + 1);
  });

  it('starts in checking with no host', () => {
    const { result } = renderHook(() => useWebappHealth(null));
    expect(result.current).toBe('checking');
  });

  it('stops polling once unmounted', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ status: 200 } as Response);
    const { unmount } = renderHook(() => useWebappHealth(HOST, 5000));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    unmount();
    const callsAtUnmount = fetchSpy.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(fetchSpy.mock.calls.length).toBe(callsAtUnmount);
  });

  it('pauses polling while the tab is hidden and resumes when it returns', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ status: 200 } as Response);
    renderHook(() => useWebappHealth(HOST, 5000));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    const callsWhenHidden = fetchSpy.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(fetchSpy.mock.calls.length).toBe(callsWhenHidden);

    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(callsWhenHidden);
  });
});
