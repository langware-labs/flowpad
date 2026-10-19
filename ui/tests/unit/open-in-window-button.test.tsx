/**
 * The global pop-out: one call to `openDockInWindow` with the addressed dock,
 * and nothing rendered where there is nothing to pop (app root) or where the
 * window already is a popout.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const openDockInWindow = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  currentDock: null as unknown,
  isDockUrl: true,
  windowMode: false,
}));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({
    navigation: { openDockInWindow },
    currentDock: state.currentDock,
    windowMode: state.windowMode,
    isDockUrl: state.isDockUrl,
  }),
}));

import { OpenInWindowButton } from '@src/components/top-nav-bar/OpenInWindowButton';
import { TooltipProvider } from '@src/components/ui/tooltip';
import { DockPointer } from '@src/navigation/DockPointer';

const renderButton = () =>
  render(
    <TooltipProvider delayDuration={0}>
      <OpenInWindowButton />
    </TooltipProvider>,
  );

beforeEach(() => {
  state.currentDock = DockPointer.forFile('/project/note.md');
  state.isDockUrl = true;
  state.windowMode = false;
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('OpenInWindowButton', () => {
  it('opens the addressed dock in a new window, exactly once', () => {
    renderButton();
    fireEvent.click(screen.getByTestId('top-nav-open-in-window'));

    expect(openDockInWindow).toHaveBeenCalledTimes(1);
    expect(openDockInWindow).toHaveBeenCalledWith(state.currentDock);
  });

  it('carries its label for assistive tech', () => {
    renderButton();
    expect(screen.getByTestId('top-nav-open-in-window').getAttribute('aria-label')).toBe('Open in new window');
  });

  it('renders nothing inside a popped-out window', () => {
    state.windowMode = true;
    renderButton();
    expect(screen.queryByTestId('top-nav-open-in-window')).toBeNull();
  });

  it('renders nothing where the strip would show no chip (home, no dock)', () => {
    state.currentDock = DockPointer.root();
    state.isDockUrl = false;
    const { unmount } = renderButton();
    expect(screen.queryByTestId('top-nav-open-in-window')).toBeNull();
    unmount();

    state.currentDock = null;
    renderButton();
    expect(screen.queryByTestId('top-nav-open-in-window')).toBeNull();
  });
});
