/**
 * A session's surface never waits on — or reads — the stored `view_mode`.
 *
 * It used to: the surface came from the preference, so on the first load in a
 * browser profile (no localStorage boot seed) it was "not known yet" until
 * `preferences.json` landed, and the session held its pane. The preference no
 * longer decides anything in the UI; a session follows its tab's stated mode or
 * the app's one mode (Vibe), so the answer is known at once, loaded or not.
 */
import { instancePreferences, InstancePreferencesEvent, PrefKey } from '@sdk';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { surfaceForViewMode, UNSTATED_VIEW_MODE, useSessionSurface } from '@src/contexts/view-mode-context';

// `view-mode-context` reads the current dock, which calls `useLocation()`.
// These tests render without a Router, so stub only that hook and keep the
// rest of the module real (a full mock would drop `useDockNavigation`).
vi.mock('@src/navigation/useDockNavigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@src/navigation/useDockNavigation')>()),
  useCurrentDock: () => null,
}));


// RTL's renderHook drives React outside a configured act environment otherwise,
// which only produces console noise here — the assertions are synchronous.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const prefs = instancePreferences as unknown as {
  _prefs: Record<string, unknown>;
  _loaded: boolean;
  _version: number;
};

function reset({ loaded, stored }: { loaded: boolean; stored?: string }) {
  delete prefs._prefs[PrefKey.VIEW_MODE];
  if (stored !== undefined) prefs._prefs[PrefKey.VIEW_MODE] = stored;
  prefs._loaded = loaded;
  prefs._version += 1;
}

afterEach(() => reset({ loaded: true }));

describe('useSessionSurface — never the stored preference', () => {
  it('is known before the preferences load: the app mode, no wait', () => {
    reset({ loaded: false });
    const { result } = renderHook(() => useSessionSurface());
    expect(result.current).toBe(surfaceForViewMode(UNSTATED_VIEW_MODE));
  });

  it('a stored mode changes nothing — loaded or seeded', () => {
    reset({ loaded: false, stored: 'standard' });
    const { result } = renderHook(() => useSessionSurface());
    expect(result.current).toBe(surfaceForViewMode(UNSTATED_VIEW_MODE));

    act(() => {
      reset({ loaded: true, stored: 'advanced' });
      instancePreferences.emit(InstancePreferencesEvent.PREFERENCES_LOADED, {});
    });
    expect(result.current).toBe(surfaceForViewMode(UNSTATED_VIEW_MODE));
  });
});
