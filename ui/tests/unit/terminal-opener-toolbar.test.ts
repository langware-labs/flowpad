import { act, renderHook } from '@testing-library/react';
import { Bot, History, SquareTerminal } from 'lucide-react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getInlineOpeners } from '@src/components/terminal/openers/TerminalOpenerToolbar';
import type { OpenerDescriptor, OpenerId } from '@src/components/terminal/openers/tab_opener_types';
import { usePinnedOpeners } from '@src/components/terminal/openers/usePinnedOpeners';

const PINNED_STORAGE_KEY = 'flowpad.terminal.pinnedOpeners';
const LAST_OPENER_STORAGE_KEY = 'flowpad.terminal.lastOpener';

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
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
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
    expect(JSON.parse(window.localStorage.getItem(LAST_OPENER_STORAGE_KEY) ?? 'null')).toBe('terminal');
    expect(JSON.parse(window.localStorage.getItem(PINNED_STORAGE_KEY) ?? 'null')).toEqual([]);
  });

  it('loads codex from pinned and last-opener storage', () => {
    window.localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify(['codex']));
    window.localStorage.setItem(LAST_OPENER_STORAGE_KEY, JSON.stringify('codex'));

    const { result } = renderHook(() => usePinnedOpeners());

    expect(result.current.pinned).toEqual(['codex']);
    expect(result.current.lastOpened).toBe('codex');
  });
});
