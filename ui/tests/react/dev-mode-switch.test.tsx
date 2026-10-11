/**
 * Developer mode is a SWITCH layered over the surface, not a fourth view mode.
 *
 * Pinned: a tab whose URL states its own mode (`?viewMode=advanced`, as every
 * session tab does) no longer hides Dev — the reason it stopped being a mode;
 * Dev on lifts the tier questions (Advanced extras, rail/type tier) on any
 * surface; a stored `view_mode = "dev"` from before still reads as Dev on, and
 * the next toggle retires it; the profile-menu avatar is the door and wears the
 * fire ring.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { PrefKey } from '@sdk';
import { instancePreferences } from '@sdk/services/InstancePreferences';

import {
  getDev,
  getViewMode,
  setDev,
  setViewMode,
  useIsAdvanced,
  useIsDev,
  useTierMode,
  ViewMode,
} from '@src/contexts/view-mode-context';
import { UserMenuHeader } from '@src/pages/flow-page/content-panel/user-dropdown/user-menu-header';

function Probe() {
  return (
    <div>
      <span data-testid="dev">{String(useIsDev())}</span>
      <span data-testid="advanced">{String(useIsAdvanced())}</span>
      <span data-testid="tier">{useTierMode()}</span>
    </div>
  );
}

function renderAt(url: string) {
  const router = createMemoryRouter([{ path: '*', element: <Probe /> }], { initialEntries: [url] });
  render(<RouterProvider router={router} />);
}

const SESSION_TAB = '/dock/shell/agentic_process-8c98d9c8-4295-4ac4-8560-788d762bd89a?viewMode=advanced';

describe('developer mode is a switch', () => {
  beforeEach(() => {
    setDev(false);
    setViewMode(ViewMode.Standard);
  });
  afterEach(() => {
    cleanup();
    setDev(false);
    setViewMode(ViewMode.Standard);
  });

  it('a session tab stating its own mode no longer hides it', () => {
    setDev(true);
    renderAt(SESSION_TAB);
    expect(screen.getByTestId('dev').textContent).toBe('true');
    expect(screen.getByTestId('tier').textContent).toBe(ViewMode.Dev);
  });

  it('lifts the tier on the simplest surface too — Vibe with Dev on gets the Advanced extras', () => {
    setDev(true);
    setViewMode(ViewMode.Vibe);
    renderAt('/');
    expect(screen.getByTestId('advanced').textContent).toBe('true');
    expect(screen.getByTestId('tier').textContent).toBe(ViewMode.Dev);
  });

  it('off: tier is the surface, nothing extra', () => {
    setViewMode(ViewMode.Vibe);
    renderAt('/');
    expect(screen.getByTestId('dev').textContent).toBe('false');
    expect(screen.getByTestId('advanced').textContent).toBe('false');
    expect(screen.getByTestId('tier').textContent).toBe(ViewMode.Vibe);
  });

  it('no argument toggles', () => {
    setDev();
    expect(getDev()).toBe(true);
    setDev();
    expect(getDev()).toBe(false);
  });

  it('a stored view_mode "dev" (Dev as a mode) still reads as on; turning it off retires it to Advanced', () => {
    instancePreferences.set(PrefKey.VIEW_MODE, ViewMode.Dev);
    expect(getDev()).toBe(true);

    setDev(false);
    expect(getDev()).toBe(false);
    expect(getViewMode()).toBe(ViewMode.Advanced);
  });
});

describe('the profile-menu avatar is the door', () => {
  afterEach(cleanup);

  it('a double-click asks to toggle; on, it wears the fire ring', () => {
    const toggle = vi.fn();
    const { rerender } = render(<UserMenuHeader name="Eran" onAvatarDoubleClick={toggle} />);
    const avatar = screen.getByTestId('user-menu-avatar');
    expect(avatar.className).not.toContain('dev-fire-ring');

    fireEvent.doubleClick(avatar);
    expect(toggle).toHaveBeenCalledTimes(1);

    rerender(<UserMenuHeader name="Eran" devMode onAvatarDoubleClick={toggle} />);
    expect(screen.getByTestId('user-menu-avatar').className).toContain('dev-fire-ring');
    expect(screen.getByTestId('user-menu-avatar').dataset.devMode).toBe('true');
  });

  it('a single click does nothing (the menu item clicks stay ordinary)', () => {
    const toggle = vi.fn();
    render(<UserMenuHeader name="Eran" onAvatarDoubleClick={toggle} />);
    fireEvent.click(screen.getByTestId('user-menu-avatar'));
    expect(toggle).not.toHaveBeenCalled();
  });
});
