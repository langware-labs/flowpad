import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, render, screen } from '@testing-library/react';

import { UpdateReadyIndicator } from '@src/components/top-nav-bar/UpdateReadyIndicator';
import { i18n } from '@lingui/core';
import {
  activationProblem,
  OPEN_VERSION_POPOVER_EVENT,
  type ActivationResult,
  type UpdateReadyState,
} from '@src/components/update-ready/update-ready';

const READY: UpdateReadyState = { ready: true, restart: true, desktop: { from: '0.2.81', to: '0.2.82' }, engine: null };

/** A desktop that pushes the ready state, like electron/main.js. */
function fakeDesktop(initial: UpdateReadyState) {
  let pushState: (s: UpdateReadyState) => void = () => {};
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    getUpdateReadyInfo: vi.fn(() => Promise.resolve(initial)),
    onUpdateReadyState: (cb: (s: UpdateReadyState) => void) => ((pushState = cb), () => {}),
  };
  return { state: (s: UpdateReadyState) => pushState(s) };
}

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('a "Restart" that did not apply', () => {
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
