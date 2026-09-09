/**
 * The hook must release BOTH of its subscriptions on unmount.
 *
 * The notification-click bridge used to be subscribed and never released, so
 * every remount stacked another IPC listener — 11 of them in a real session
 * (`MaxListenersExceededWarning`). Each listener navigates, so one banner click
 * fired `navigateTo` once per leaked listener.
 *
 * The disposer is OPTIONAL by design: the desktop shell and this UI ship as
 * separately versioned artifacts, so a shell older than the preload change
 * returns nothing and the hook must still mount and unmount cleanly.
 */
import '@testing-library/jest-dom/vitest';

import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const cm = vi.hoisted(() => ({ on: vi.fn(), off: vi.fn() }));
vi.mock('@sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sdk')>()),
  ConnectionManager: { getInstance: () => cm },
}));

import { useUiCommandListener } from '@src/hooks/use-ui-command-listener';

function withBridge(onNotificationClick: unknown): void {
  (window as unknown as { electronAPI?: unknown }).electronAPI = { onNotificationClick };
}

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  cm.on.mockClear();
  cm.off.mockClear();
});

describe('useUiCommandListener — cleanup', () => {
  it('releases the notification-click subscription on unmount', () => {
    const dispose = vi.fn();
    const subscribe = vi.fn(() => dispose);
    withBridge(subscribe);

    const { unmount } = renderHook(() => useUiCommandListener());
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();

    unmount();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(cm.off).toHaveBeenCalledWith('on_ui_command', expect.any(Function));
  });

  it('does not stack listeners across remounts', () => {
    const disposers: Array<() => void> = [];
    const subscribe = vi.fn(() => {
      const d = vi.fn();
      disposers.push(d);
      return d;
    });
    withBridge(subscribe);

    for (let i = 0; i < 5; i++) renderHook(() => useUiCommandListener()).unmount();

    // Every subscription was matched by its own release — the invariant the
    // MaxListeners warning was reporting the absence of.
    expect(subscribe).toHaveBeenCalledTimes(5);
    expect(disposers).toHaveLength(5);
    for (const d of disposers) expect(d).toHaveBeenCalledTimes(1);
  });

  it('mounts and unmounts against an older shell that returns no disposer', () => {
    // Pre-fix preload: `ipcRenderer.on(...)` returns a non-callable. Unmount
    // must not throw — the shell can be months behind this UI.
    withBridge(vi.fn(() => undefined));
    const { unmount } = renderHook(() => useUiCommandListener());
    expect(() => unmount()).not.toThrow();
  });

  it('mounts in a browser, where there is no bridge at all', () => {
    const { unmount } = renderHook(() => useUiCommandListener());
    expect(() => unmount()).not.toThrow();
  });
});
