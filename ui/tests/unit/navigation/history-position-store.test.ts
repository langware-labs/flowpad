/**
 * The store around the history model — the I/O seam.
 *
 * Everything here is driven through an injected `Window`, never through jsdom's
 * own session history (see history-position.test.ts for why that would be a
 * test that passes for the wrong reason). What IS worth testing here is the
 * plumbing the reducer can't cover: subscriber notification, and the
 * sessionStorage round-trip that makes Forward survive a reload.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  bindHistoryPosition,
  getHistoryPosition,
  resetHistoryPositionForTests,
  subscribeHistoryPosition,
  syncHistoryPosition,
} from '@src/navigation/history-position-store';

/** Minimal stand-in for the parts of Window the store reads. */
function fakeWindow(idx: number | null): Window {
  return {
    history: { state: idx === null ? null : { idx } },
    location: { pathname: '/dock/home' },
  } as unknown as Window;
}

beforeEach(() => {
  resetHistoryPositionForTests();
  sessionStorage.clear();
  localStorage.clear();
});

describe('the history position store', () => {
  it('exposes the reduced position and notifies once per change', () => {
    const onChange = vi.fn();
    subscribeHistoryPosition(onChange);

    syncHistoryPosition('PUSH', fakeWindow(0));
    expect(getHistoryPosition()).toMatchObject({ idx: 0, canGoBack: false, canGoForward: false });
    expect(onChange).toHaveBeenCalledTimes(1);

    syncHistoryPosition('PUSH', fakeWindow(1));
    expect(getHistoryPosition()).toMatchObject({ idx: 1, canGoBack: true, canGoForward: false });
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('does not notify when nothing changed', () => {
    syncHistoryPosition('PUSH', fakeWindow(2));
    const onChange = vi.fn();
    subscribeHistoryPosition(onChange);

    syncHistoryPosition('REPLACE', fakeWindow(2));

    expect(onChange).not.toHaveBeenCalled();
  });

  it('goes back and forward within the stack', () => {
    syncHistoryPosition('PUSH', fakeWindow(0));
    syncHistoryPosition('PUSH', fakeWindow(1));
    syncHistoryPosition('PUSH', fakeWindow(2));

    syncHistoryPosition('POP', fakeWindow(1)); // back
    expect(getHistoryPosition()).toMatchObject({ canGoBack: true, canGoForward: true });

    syncHistoryPosition('POP', fakeWindow(2)); // forward again
    expect(getHistoryPosition()).toMatchObject({ canGoBack: true, canGoForward: false });
  });

  it('kills forward when a push happens mid-history', () => {
    syncHistoryPosition('PUSH', fakeWindow(0));
    syncHistoryPosition('PUSH', fakeWindow(1));
    syncHistoryPosition('PUSH', fakeWindow(2));
    syncHistoryPosition('POP', fakeWindow(1));
    expect(getHistoryPosition().canGoForward).toBe(true);

    syncHistoryPosition('PUSH', fakeWindow(2)); // new navigation truncates

    expect(getHistoryPosition().canGoForward).toBe(false);
  });

  it('carries the forward ceiling across a reload', () => {
    syncHistoryPosition('PUSH', fakeWindow(0));
    syncHistoryPosition('PUSH', fakeWindow(1));
    syncHistoryPosition('PUSH', fakeWindow(2));
    syncHistoryPosition('POP', fakeWindow(1));

    // F5: the module state is gone, but the browser kept idx in history state
    // and we kept the ceiling in sessionStorage.
    resetHistoryPositionForTests();
    syncHistoryPosition('POP', fakeWindow(1));

    expect(getHistoryPosition()).toMatchObject({ canGoBack: true, canGoForward: true });
  });

  it('ignores a corrupt stored ceiling instead of throwing', () => {
    sessionStorage.setItem('flowpad.history.maxIdx', 'not-a-number');

    expect(() => syncHistoryPosition('POP', fakeWindow(3))).not.toThrow();
    expect(getHistoryPosition()).toMatchObject({ idx: 3, maxIdx: 3, canGoForward: false });
  });

  it('fails closed when history state carries no index', () => {
    syncHistoryPosition('POP', fakeWindow(null));

    expect(getHistoryPosition()).toMatchObject({ canGoBack: false, canGoForward: false });
  });

  it('ignores in-flight router states, whose action is still the previous one', () => {
    // Caught in the browser: the router notifies several times per navigation
    // and `historyAction` only becomes the NEW action once the navigation
    // settles. Mid-pop it still reads PUSH while idx has already moved back —
    // folding that in resets the forward ceiling, and Forward dies the moment
    // you press Back.
    window.history.replaceState({ idx: 1 }, '');
    let notify!: (s: { historyAction: 'PUSH' | 'POP'; navigation?: { state?: string } }) => void;
    bindHistoryPosition({
      subscribe: (fn: never) => {
        notify = fn;
        return () => {};
      },
    } as never);

    notify({ historyAction: 'PUSH', navigation: { state: 'idle' } }); // arrive at 1
    expect(getHistoryPosition()).toMatchObject({ idx: 1, maxIdx: 1 });

    // The browser pops first, so idx is already 0 while the action still says
    // PUSH. This notification must be ignored outright — folding it in would
    // set maxIdx to 0 and kill Forward.
    window.history.replaceState({ idx: 0 }, '');
    notify({ historyAction: 'PUSH', navigation: { state: 'loading' } });
    expect(getHistoryPosition()).toMatchObject({ idx: 1, maxIdx: 1 });

    notify({ historyAction: 'POP', navigation: { state: 'idle' } }); // settles
    expect(getHistoryPosition()).toMatchObject({ idx: 0, maxIdx: 1, canGoForward: true });
  });

  it('seeds from the router and drops the retired shadow-stack key', () => {
    localStorage.setItem('navigation-history', '{"state":{"history":[]}}');
    // Stand in for what createBrowserHistory does at creation: stamp idx onto
    // the entry we booted on. bindHistoryPosition reads the live window, so
    // without this it would (correctly) fail closed.
    window.history.replaceState({ idx: 2 }, '');

    let notify: ((s: { historyAction: 'POP' | 'PUSH' }) => void) | null = null;
    const router = {
      subscribe: (fn: (s: { historyAction: 'POP' | 'PUSH' }) => void) => {
        notify = fn;
        return () => {};
      },
    };

    const unbind = bindHistoryPosition(router);

    expect(localStorage.getItem('navigation-history')).toBeNull();
    // Seeded mid-history: back available, forward unknown and so disabled.
    expect(getHistoryPosition()).toMatchObject({ idx: 2, canGoBack: true, canGoForward: false });

    expect(notify).not.toBeNull();
    window.history.replaceState({ idx: 3 }, '');
    notify!({ historyAction: 'PUSH' });
    expect(getHistoryPosition().idx).toBe(3);

    unbind();
  });
});
