/**
 * A view mode is read off a SESSION's address — and only there.
 *
 * Pinned: a page's `?viewMode` is ignored (one look); a session's is displayed
 * without being saved as "the last mode selected"; only a marked switch — what
 * the session's own switch navigates with — saves it.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router';

import { PrefKey, instancePreferences } from '@sdk';
import {
  setViewMode,
  useDockViewModeOverrideSync,
  useViewMode,
  VIEW_MODE_SWITCH_STATE,
  ViewMode,
} from '@src/contexts/view-mode-context';

function Probe() {
  useDockViewModeOverrideSync();
  const mode = useViewMode();
  const location = useLocation();
  return (
    <div>
      <div data-testid="effective-mode">{mode}</div>
      <div data-testid="location">
        {location.pathname}
        {location.search}
      </div>
    </div>
  );
}

function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      { path: '/', element: <Probe /> },
      { path: '/dock/:viewType', element: <Probe /> },
      { path: '/dock/:viewType/*', element: <Probe /> },
    ],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

const SESSION = '/dock/shell/shell-1';
const mode = () => screen.getByTestId('effective-mode').textContent;

describe('DockPointer viewMode override', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('view-mode-glow-flicker');
    setViewMode(ViewMode.Standard);
  });

  afterEach(() => {
    cleanup();
    setViewMode(ViewMode.Standard);
    document.documentElement.classList.remove('view-mode-glow-flicker');
  });

  it.each(['/dock/settings?viewMode=advanced', '/?viewMode=standard', '/dock/assets/list/skill?viewMode=dev'])(
    'a page has one look — %s shows the app mode',
    async (url) => {
      renderAt(url);

      await waitFor(() => expect(mode()).toBe('vibe'));
      expect(document.documentElement.getAttribute('data-view')).toBe('vibe');
      expect(instancePreferences.get(PrefKey.VIEW_MODE)).toBe('standard');
    },
  );

  it("a session's ?viewMode on load is displayed, not saved as the last selected mode", async () => {
    renderAt(`${SESSION}?viewMode=advanced`);

    await waitFor(() => expect(mode()).toBe('advanced'));
    expect(document.documentElement.getAttribute('data-view')).toBe('advanced');
    expect(instancePreferences.get(PrefKey.VIEW_MODE)).toBe('standard');
  });

  it('a mode added to a bare session URL without the switch marker is displayed, not saved', async () => {
    const router = renderAt(SESSION);

    await waitFor(() => expect(mode()).toBe('vibe'));
    // What a redirect does: same dock, a mode appears, but the user switched nothing.
    await router.navigate(`${SESSION}?viewMode=advanced`);

    await waitFor(() => expect(mode()).toBe('advanced'));
    expect(instancePreferences.get(PrefKey.VIEW_MODE)).toBe('standard');
  });

  it('a marked switch on a session saves the mode and shows the glow flicker', async () => {
    const router = renderAt(`${SESSION}?viewMode=advanced`);

    await waitFor(() => expect(mode()).toBe('advanced'));
    document.documentElement.classList.remove('view-mode-glow-flicker');

    await router.navigate(`${SESSION}?viewMode=standard`, { state: VIEW_MODE_SWITCH_STATE });

    await waitFor(() => expect(mode()).toBe('standard'));
    await waitFor(() => expect(instancePreferences.get(PrefKey.VIEW_MODE)).toBe('standard'));
    expect(document.documentElement.classList.contains('view-mode-glow-flicker')).toBe(true);

    await router.navigate(`${SESSION}?viewMode=advanced`, { state: VIEW_MODE_SWITCH_STATE });
    await waitFor(() => expect(instancePreferences.get(PrefKey.VIEW_MODE)).toBe('advanced'));
  });
});
