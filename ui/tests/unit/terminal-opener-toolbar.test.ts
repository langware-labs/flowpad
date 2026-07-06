import { act, renderHook } from '@testing-library/react';
import { Bot, History, SquareTerminal } from 'lucide-react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { instancePreferences, PrefKey } from '@sdk';
import { getInlineOpeners } from '@src/components/terminal/openers/TerminalOpenerToolbar';
import type { OpenerDescriptor, OpenerId } from '@src/components/terminal/openers/tab_opener_types';
import { usePinnedOpeners } from '@src/components/terminal/openers/usePinnedOpeners';
import { resetOpenerPrefs } from '../utils/opener-prefs';

// usePinnedOpeners persists through the registry-driven preference store
// (PrefKey.LAST_OPENER / PINNED_OPENERS), not raw localStorage anymore.

function opener(id: OpenerId, available = true): OpenerDescriptor {
  return {
    id,
    label: id,
    Icon: id === 'terminal' ? SquareTerminal : id === 'history' ? History : Bot,
    onActivate: () => {},
    available,
  };
}

function ids(openers: OpenerDescriptor[]): OpenerId[] {
  return openers.map((item) => item.id);
}

describe('terminal opener toolbar memory slot', () => {
  beforeEach(() => {
    resetOpenerPrefs();
  });

  afterEach(() => {
    resetOpenerPrefs();
  });

  it('adds the last opened opener after pinned openers when it is not pinned', () => {
    const openers = [opener('claude'), opener('terminal'), opener('history')];

    expect(ids(getInlineOpeners(openers, [], 'terminal'))).toEqual(['terminal']);
    expect(ids(getInlineOpeners(openers, ['claude'], 'terminal'))).toEqual(['claude', 'terminal']);
  });

  it('does not render the last opened opener twice when it is pinned', () => {
    const openers = [opener('claude'), opener('terminal'), opener('history')];

    expect(ids(getInlineOpeners(openers, ['terminal'], 'terminal'))).toEqual(['terminal']);
    expect(ids(getInlineOpeners(openers, ['claude', 'terminal'], 'terminal'))).toEqual(['claude', 'terminal']);
  });

  it('remembers a single last opener without auto-pinning it', () => {
    const { result } = renderHook(() => usePinnedOpeners());

    act(() => {
      result.current.rememberOpened('claude');
    });
    expect(result.current.lastOpened).toBe('claude');
    expect(result.current.pinned).toEqual([]);

    act(() => {
      result.current.rememberOpened('terminal');
    });
    expect(result.current.lastOpened).toBe('terminal');
    expect(result.current.pinned).toEqual([]);
    expect(instancePreferences.get(PrefKey.LAST_OPENER)).toBe('terminal');
    expect(instancePreferences.get(PrefKey.PINNED_OPENERS)).toEqual([]);
  });

  it('loads codex from pinned and last-opener storage', () => {
    instancePreferences.set(PrefKey.PINNED_OPENERS, ['codex']);
    instancePreferences.set(PrefKey.LAST_OPENER, 'codex');

    const { result } = renderHook(() => usePinnedOpeners());

    expect(result.current.pinned).toEqual(['codex']);
    expect(result.current.lastOpened).toBe('codex');
  });
});
