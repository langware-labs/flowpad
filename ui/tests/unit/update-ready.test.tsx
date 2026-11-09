import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, render, screen } from '@testing-library/react';

const commands = vi.hoisted(() => new Map<string, (args: unknown, ctx: { id: string }) => void>());
vi.mock('@src/notifications', () => ({
  notify: { info: vi.fn() },
  registerCommand: (name: string, fn: (args: unknown, ctx: { id: string }) => void) => commands.set(name, fn),
}));
vi.mock('@src/notifications/notify', () => ({ closeShown: vi.fn() }));

import { notify } from '@src/notifications';
import { closeShown } from '@src/notifications/notify';
import { UpdateReadyBridge, UPDATE_READY_TOAST_MS } from '@src/components/update-ready/UpdateReadyBridge';
import { UpdateReadyIndicator } from '@src/components/top-nav-bar/UpdateReadyIndicator';
import { OPEN_VERSION_POPOVER_EVENT, type UpdateReadyState } from '@src/components/update-ready/update-ready';

const READY: UpdateReadyState = { ready: true, restart: true, desktop: { from: '0.2.81', to: '0.2.82' }, engine: null };

/** A desktop that pushes the ready state and asks for the toast, like electron/main.js. */
function fakeDesktop(initial: UpdateReadyState) {
  let pushState: (s: UpdateReadyState) => void = () => {};
  let pushToast: (s: UpdateReadyState) => void = () => {};
  const api = {
    getUpdateReadyInfo: vi.fn(() => Promise.resolve(initial)),
    activateUpdate: vi.fn(() => Promise.resolve({ started: true })),
    onUpdateReadyState: (cb: (s: UpdateReadyState) => void) => ((pushState = cb), () => {}),
    onUpdateReadyToast: (cb: (s: UpdateReadyState) => void) => ((pushToast = cb), () => {}),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = api;
  return { api, state: (s: UpdateReadyState) => pushState(s), toast: (s: UpdateReadyState) => pushToast(s) };
}

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  vi.clearAllMocks();
});

describe('"Update Ready" toast', () => {
  it('shows ONE non-blocking toast for 30 seconds when the desktop asks — Restart / Later', () => {
    const desktop = fakeDesktop(READY);
    render(<UpdateReadyBridge />);
    act(() => desktop.toast(READY));
    expect(notify.info).toHaveBeenCalledTimes(1);
    const toast = vi.mocked(notify.info).mock.calls[0][0];
    expect(toast).toMatchObject({ id: 'update-ready', title: 'Update Ready', durationMs: UPDATE_READY_TOAST_MS });
    expect(UPDATE_READY_TOAST_MS).toBe(30_000);
    expect(toast.actions?.map((a) => a.command)).toEqual(['update.restart', 'update.later']);
  });

  it('Restart closes it and applies the update; Later only closes it', () => {
    const desktop = fakeDesktop(READY);
    commands.get('update.later')!({}, { id: 'update-ready' });
    expect(closeShown).toHaveBeenCalledWith('update-ready');
    expect(desktop.api.activateUpdate).not.toHaveBeenCalled();
    commands.get('update.restart')!({}, { id: 'update-ready' });
    expect(desktop.api.activateUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('top bar "Update ready" indicator', () => {
  it('shows only while an update is ready, and opens the version popover', async () => {
    const desktop = fakeDesktop({ ready: false, restart: false, desktop: null, engine: null });
    render(<UpdateReadyIndicator />);
    await act(async () => {});
    expect(screen.queryByTestId('top-nav-update-ready')).toBeNull();
    act(() => desktop.state(READY));
    const opened = vi.fn();
    window.addEventListener(OPEN_VERSION_POPOVER_EVENT, opened);
    act(() => screen.getByTestId('top-nav-update-ready').click());
    expect(opened).toHaveBeenCalledTimes(1);
    act(() => desktop.state({ ready: false, restart: false, desktop: null, engine: null }));
    expect(screen.queryByTestId('top-nav-update-ready')).toBeNull();
  });

  it('a browser (no desktop updater) shows nothing', async () => {
    render(<UpdateReadyIndicator />);
    await act(async () => {});
    expect(screen.queryByTestId('top-nav-update-ready')).toBeNull();
  });
});
