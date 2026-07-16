import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router';

import { PrefKey, instancePreferences } from '@sdk';
import { resetRevealedModes, ViewToggle } from '@src/components/view-toggle/view-toggle';
import {
  setViewMode,
  useDockViewModeOverrideSync,
  useViewMode,
  ViewMode,
} from '@src/contexts/view-mode-context';

function Probe({ toggle = false }: { toggle?: boolean }) {
  useDockViewModeOverrideSync();
  const mode = useViewMode();
  const location = useLocation();

  return (
    <div>
      <div data-testid="effective-mode">{mode}</div>
      <div data-testid="location">{location.pathname}{location.search}</div>
      {toggle && <ViewToggle />}
    </div>
  );
}

function renderAt(path: string, toggle = false) {
  const router = createMemoryRouter(
    [
      { path: '/', element: <Probe toggle={toggle} /> },
      { path: '/dock/:viewType', element: <Probe toggle={toggle} /> },
      { path: '/dock/:viewType/*', element: <Probe toggle={toggle} /> },
    ],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe('DockPointer viewMode override', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('view-mode-glow-flicker');
    setViewMode(ViewMode.Standard);
    resetRevealedModes();
  });

  afterEach(() => {
    cleanup();
    setViewMode(ViewMode.Standard);
    document.documentElement.classList.remove('view-mode-glow-flicker');
  });

  it('adopts ?viewMode on load: applies it AND persists it as the user default', async () => {
    renderAt('/dock/settings?viewMode=advanced');

    await waitFor(() => expect(screen.getByTestId('effective-mode').textContent).toBe('advanced'));
    expect(document.documentElement.getAttribute('data-view')).toBe('advanced');
    expect(instancePreferences.get(PrefKey.VIEW_MODE)).toBe('advanced');
  });

  it('keeps the adopted mode when navigating to a DockPointer without an override', async () => {
    const router = renderAt('/dock/settings?viewMode=advanced');

    await waitFor(() => expect(screen.getByTestId('effective-mode').textContent).toBe('advanced'));
    await router.navigate('/dock/settings');

    await waitFor(() => expect(screen.getByTestId('effective-mode').textContent).toBe('advanced'));
    expect(document.documentElement.getAttribute('data-view')).toBe('advanced');
    expect(instancePreferences.get(PrefKey.VIEW_MODE)).toBe('advanced');
  });

  it('footer click on a dock URL without an override navigates instead of writing the pref', async () => {
    renderAt('/dock/settings', true);

    await waitFor(() => expect(screen.getByTestId('effective-mode').textContent).toBe('standard'));

    // Advanced is hidden by default — double-click the selected Standard
    // button to reveal it first.
    fireEvent.doubleClick(screen.getByTestId('view-toggle-standard'));
    fireEvent.click(screen.getByTestId('view-toggle-advanced'));

    // The click itself only navigates; the mode then lands via the load-time sync.
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toContain('viewMode=advanced'),
    );
    await waitFor(() => expect(screen.getByTestId('effective-mode').textContent).toBe('advanced'));
    expect(instancePreferences.get(PrefKey.VIEW_MODE)).toBe('advanced');
  });

  it('switches an existing override through the URL and shows the glow flicker', async () => {
    renderAt('/dock/agentic_process/123?viewMode=advanced', true);

    await waitFor(() => expect(screen.getByTestId('effective-mode').textContent).toBe('advanced'));
    document.documentElement.classList.remove('view-mode-glow-flicker');

    fireEvent.click(screen.getByTestId('view-toggle-vibe'));

    await waitFor(() => expect(screen.getByTestId('effective-mode').textContent).toBe('vibe'));
    expect(screen.getByTestId('location').textContent).toContain('viewMode=vibe');
    expect(instancePreferences.get(PrefKey.VIEW_MODE)).toBe('vibe');
    expect(document.documentElement.classList.contains('view-mode-glow-flicker')).toBe(true);
  });
});
