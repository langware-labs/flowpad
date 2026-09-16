import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

// Count how many times a settings LIST is actually re-read from the backend.
// Each `loadAll()` in the hook calls `.load()` once per scope; we count the
// USER scope (always loaded) so one count == one full reload cycle.
let userLoadCount = 0;

function makeList() {
  return {
    load: () => {
      userLoadCount += 1;
      return Promise.resolve();
    },
  };
}
function makeOptionalList() {
  return { load: () => Promise.resolve() };
}

// Replace ONLY ClaudeSettingsJsonRecordList; everything else in @sdk stays real
// so the shared unit testSetup is untouched.
vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  class ClaudeSettingsJsonRecordList {
    static forUser() {
      return makeList();
    }
    static forProject() {
      return makeOptionalList();
    }
    static forLocal() {
      return makeOptionalList();
    }
  }
  return { ...actual, ClaudeSettingsJsonRecordList };
});

import { useClaudeSettings } from '@src/hooks/useClaudeSettings';

// Flush queued microtasks (the hook's async loadAll resolves on the microtask
// queue) without advancing wall-clock time.
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
}

describe('useClaudeSettings — reload on focus, not on a 5s timer', () => {
  beforeEach(() => {
    userLoadCount = 0;
    setVisibility('visible');
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Unmount mounted hooks so their focus/visibility listeners don't bleed
    // into later tests (the unit tier has no RTL auto-cleanup).
    cleanup();
    vi.useRealTimers();
  });

  it('does NOT reload after 5s of idle time (no interval), but DOES reload on focus', async () => {
    const { unmount } = renderHook(() =>
      useClaudeSettings('node-1', '/proj', /* poll */ true),
    );

    // Initial mount performs exactly one load cycle.
    await flush();
    expect(userLoadCount).toBe(1);

    // Advancing 5s (and well beyond) must NOT trigger any reload — the timer
    // is gone. (FAIL-before: the old setInterval(reload, 5000) re-read here.)
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    await flush();
    expect(userLoadCount).toBe(1);

    await act(async () => {
      vi.advanceTimersByTime(60000);
    });
    await flush();
    expect(userLoadCount).toBe(1);

    // A window focus while the tab is visible triggers exactly one reload.
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await flush();
    expect(userLoadCount).toBe(2);

    unmount();
  });

  it('fires reload only ONCE when focus + visibilitychange both land together', async () => {
    renderHook(() => useClaudeSettings('node-1', '/proj', true));
    await flush();
    expect(userLoadCount).toBe(1);

    // Both events arrive back-to-back (same instant under fake timers); the
    // double-fire guard collapses them into a single reload.
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await flush();
    expect(userLoadCount).toBe(2);
  });

  it('ignores focus/visibility events while the tab is hidden', async () => {
    renderHook(() => useClaudeSettings('node-1', '/proj', true));
    await flush();
    expect(userLoadCount).toBe(1);

    setVisibility('hidden');
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await flush();
    expect(userLoadCount).toBe(1);
  });

  it('does not attach focus listeners when poll is disabled', async () => {
    renderHook(() => useClaudeSettings('node-1', '/proj', /* poll */ false));
    await flush();
    expect(userLoadCount).toBe(1);

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await flush();
    expect(userLoadCount).toBe(1);
  });
});
