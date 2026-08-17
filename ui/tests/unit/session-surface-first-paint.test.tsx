/**
 * First-paint race: `useSessionSurface()` must report "not known yet" rather than
 * the registry default while the stored preference has not been read in.
 *
 * The bug it guards: on the first load in a browser profile there is no
 * localStorage boot seed for `preferences.ui.view_mode`, so `get()` served the
 * registry default and the session painted that surface for ~1s until
 * `preferences.json` landed — then repainted into the user's real one. Callers
 * hold the arrangement while this is null, so nothing wrong is painted.
 *
 * (Ported from the chat-mode preference, which this one absorbed — the surface
 * is now derived from the single view mode.)
 */
import { instancePreferences, InstancePreferencesEvent, PREF_REGISTRY, PrefKey } from '@sdk';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { surfaceForViewMode, useSessionSurface, ViewMode } from '@src/contexts/view-mode-context';

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

describe('useSessionSurface first-paint resolution', () => {
  it('is null while nothing has been read in — no default is painted', () => {
    reset({ loaded: false });
    const { result } = renderHook(() => useSessionSurface());
    expect(result.current).toBeNull();
  });

  it('resolves to the stored mode once the preferences load', () => {
    reset({ loaded: false });
    const { result } = renderHook(() => useSessionSurface());
    expect(result.current).toBeNull();

    act(() => {
      reset({ loaded: true, stored: 'advanced' });
      instancePreferences.emit(InstancePreferencesEvent.PREFERENCES_LOADED, {});
    });
    expect(result.current).toBe('terminal');
  });

  it('resolves to the default surface once loaded with nothing stored', () => {
    reset({ loaded: true });
    const { result } = renderHook(() => useSessionSurface());
    expect(result.current).toBe(surfaceForViewMode(PREF_REGISTRY[PrefKey.VIEW_MODE].defaultValue as ViewMode));
  });

  it('does not wait when a boot seed is already present', () => {
    // The steady state: every load after the first has the localStorage seed, so
    // the value is known synchronously and there is nothing to hold for.
    reset({ loaded: false, stored: 'standard' });
    const { result } = renderHook(() => useSessionSurface());
    expect(result.current).toBe('chat');
  });
});
