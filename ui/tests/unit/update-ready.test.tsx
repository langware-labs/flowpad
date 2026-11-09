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
import { i18n } from '@lingui/core';
import {
  activationProblem,
  OPEN_VERSION_POPOVER_EVENT,
  type ActivationResult,
  type UpdateReadyState,
} from '@src/components/update-ready/update-ready';

const READY: UpdateReadyState = { ready: true, restart: true, desktop: { from: '0.2.81', to: '0.2.82' }, engine: null };

/** A desktop that pushes the ready state and asks for the toast, like electron/main.js: each toast is taken once. */
function fakeDesktop(
  initial: UpdateReadyState,
  { pendingToast = null as UpdateReadyState | null, activation = { started: true } as ActivationResult } = {},
) {
  let pushState: (s: UpdateReadyState) => void = () => {};
  let pushToast: (s: UpdateReadyState) => void = () => {};
  let pending = pendingToast;
  const api = {
    getUpdateReadyInfo: vi.fn(() => Promise.resolve(initial)),
    activateUpdate: vi.fn(() => Promise.resolve(activation)),
    takeUpdateReadyToast: vi.fn(() => {
      const s = pending;
      pending = null;
      return Promise.resolve(s);
    }),
    onUpdateReadyState: (cb: (s: UpdateReadyState) => void) => ((pushState = cb), () => {}),
    onUpdateReadyToast: (cb: (s: UpdateReadyState) => void) => ((pushToast = cb), () => {}),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = api;
  const toast = (s: UpdateReadyState) => {
    pending = s;
    pushToast(s);
  };
  return { api, state: (s: UpdateReadyState) => pushState(s), toast };
}

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  vi.clearAllMocks();
});

describe('"Update Ready" toast', () => {
  it('shows ONE non-blocking toast for 30 seconds when the desktop asks — Restart / Later', async () => {
    const desktop = fakeDesktop(READY);
    render(<UpdateReadyBridge />);
    act(() => desktop.toast(READY));
    await act(async () => {}); // the desktop hands the toast out (a promise)
    expect(notify.info).toHaveBeenCalledTimes(1);
    const toast = vi.mocked(notify.info).mock.calls[0][0];
    expect(toast).toMatchObject({ id: 'update-ready', title: 'Update Ready', durationMs: UPDATE_READY_TOAST_MS });
    expect(UPDATE_READY_TOAST_MS).toBe(30_000);
    expect(toast.actions?.map((a) => a.command)).toEqual(['update.restart', 'update.later']);
  });

  it('a toast asked for while the UI was still mounting is shown on mount — once', async () => {
    fakeDesktop(READY, { pendingToast: READY });
    const { unmount } = render(<UpdateReadyBridge />);
    await act(async () => {});
    expect(notify.info).toHaveBeenCalledTimes(1);
    unmount();
    render(<UpdateReadyBridge />); // a reload: the desktop handed it out already
    await act(async () => {});
    expect(notify.info).toHaveBeenCalledTimes(1);
  });

  it('a Restart that does not apply opens the version popover to say why (the toast is already closed)', async () => {
    fakeDesktop(READY, { activation: { started: false, reason: 'busy' } });
    const opened = vi.fn();
    window.addEventListener(OPEN_VERSION_POPOVER_EVENT, opened);
    act(() => commands.get('update.restart')!({}, { id: 'update-ready' }));
    await act(async () => {}); // the activation's answer
    window.removeEventListener(OPEN_VERSION_POPOVER_EVENT, opened);
    expect(closeShown).toHaveBeenCalledWith('update-ready');
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ activation: { started: false, reason: 'busy' } });
  });

  it('says why "Restart" did not apply — not "another update" for every failure', () => {
    const say = (r: ActivationResult) => {
      const m = activationProblem(r);
      return m ? i18n._(m) : null;
    };
    expect(say({ started: true })).toBeNull();
    expect(say({ started: true, success: true })).toBeNull();
    expect(say({ started: false, reason: 'busy' })).toMatch(/Another update is in progress/);
    expect(say({ started: false, reason: 'not-ready' })).toMatch(/no longer ready/);
    expect(say({ started: true, success: false, error: 'disk full' })).toBe('Install failed: disk full');
    expect(say({ started: false })).toMatch(/could not be applied/);
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
