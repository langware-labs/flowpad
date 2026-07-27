/**
 * First-paint race: `useChatMode()` must report "not known yet" rather than the
 * registry default while the stored preference has not been read in.
 *
 * The bug it guards: on the first load in a browser profile there is no
 * localStorage boot seed for `preferences.ui.chat_ui_mode`, so `get()` served the
 * registry default and the session painted that mode for ~1s until
 * `preferences.json` landed — then repainted into the user's real mode. Callers
 * hold the arrangement while this is null, so nothing wrong is painted.
 */
import { instancePreferences, InstancePreferencesEvent, PrefKey } from '@sdk';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { useChatMode } from '@src/contexts/chat-ui-mode-context';

// RTL's renderHook drives React outside a configured act environment otherwise,
// which only produces console noise here — the assertions are synchronous.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const prefs = instancePreferences as unknown as {
  _prefs: Record<string, unknown>;
  _loaded: boolean;
  _version: number;
};

function reset({ loaded, stored }: { loaded: boolean; stored?: string }) {
  delete prefs._prefs[PrefKey.CHAT_UI_MODE];
  if (stored !== undefined) prefs._prefs[PrefKey.CHAT_UI_MODE] = stored;
  prefs._loaded = loaded;
  prefs._version += 1;
}

afterEach(() => reset({ loaded: true }));

describe('useChatMode first-paint resolution', () => {
  it('is null while nothing has been read in — no default is painted', () => {
    reset({ loaded: false });
    const { result } = renderHook(() => useChatMode());
    expect(result.current).toBeNull();
  });

  it('resolves to the stored mode once the preferences load', () => {
    reset({ loaded: false });
    const { result } = renderHook(() => useChatMode());
    expect(result.current).toBeNull();

    act(() => {
      reset({ loaded: true, stored: 'terminal' });
      instancePreferences.emit(InstancePreferencesEvent.PREFERENCES_LOADED, {});
    });
    expect(result.current).toBe('terminal');
  });

  it('resolves to the default once loaded with nothing stored', () => {
    reset({ loaded: true });
    const { result } = renderHook(() => useChatMode());
    expect(result.current).toBe('vibe');
  });

  it('does not wait when a boot seed is already present', () => {
    // The steady state: every load after the first has the localStorage seed, so
    // the value is known synchronously and there is nothing to hold for.
    reset({ loaded: false, stored: 'chat' });
    const { result } = renderHook(() => useChatMode());
    expect(result.current).toBe('chat');
  });
});
