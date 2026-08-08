/**
 * The history position model.
 *
 * This is where the real coverage for Back/Forward lives, and deliberately so:
 * the browser owns the truth about session history, and neither jsdom nor
 * `createMemoryRouter` reproduces it faithfully. `createMemoryRouter` never
 * writes `window.history.state.idx` at all, so a test through it would read
 * null and assert the fail-closed path — passing for the wrong reason. jsdom's
 * `history.go/back/forward` is an async approximation that does NOT reproduce
 * forward-stack truncation on push, which is precisely the behaviour that was
 * broken. So: the reducer holds the semantics and is fully tested here; the
 * browser holds the truth and is covered by the Playwright tier.
 */
import { describe, it, expect } from 'vitest';
import { reduceHistoryPosition, UNAVAILABLE } from '@src/navigation/history-position';

describe('reduceHistoryPosition', () => {
  it('drops the ceiling to the new entry on PUSH', () => {
    // The regression test for the original bug: the old shadow stack kept the
    // forward entries alive after a push, so Forward stayed enabled and pointed
    // at history the browser had already discarded.
    const next = reduceHistoryPosition({ maxIdx: 5 }, { idx: 3, action: 'PUSH' });

    expect(next.maxIdx).toBe(3);
    expect(next.canGoForward).toBe(false);
    expect(next.canGoBack).toBe(true);
  });

  it('keeps the ceiling on POP so forward stays available', () => {
    const next = reduceHistoryPosition({ maxIdx: 5 }, { idx: 4, action: 'POP' });

    expect(next.maxIdx).toBe(5);
    expect(next.canGoForward).toBe(true);
  });

  it('keeps the ceiling on REPLACE', () => {
    // replaceState does not discard forward entries, and react-router's replace
    // leaves idx alone — so a <Navigate replace> must not kill Forward.
    const next = reduceHistoryPosition({ maxIdx: 5 }, { idx: 2, action: 'REPLACE' });

    expect(next.maxIdx).toBe(5);
    expect(next.canGoForward).toBe(true);
  });

  it('raises the ceiling when a POP lands beyond it', () => {
    const next = reduceHistoryPosition({ maxIdx: 2 }, { idx: 6, action: 'POP' });

    expect(next.maxIdx).toBe(6);
    expect(next.canGoForward).toBe(false);
  });

  it('seeds the ceiling from a cold boot mid-history', () => {
    // The other original bug: after a reload the persisted stack left Back
    // disabled and Forward enabled — exactly backwards. Landing at idx 7 with no
    // memory must mean "back available, forward unknown".
    const next = reduceHistoryPosition({ maxIdx: -1 }, { idx: 7, action: 'POP' });

    expect(next).toEqual({ idx: 7, maxIdx: 7, canGoBack: true, canGoForward: false });
  });

  it('has nowhere to go back to at the first entry', () => {
    const next = reduceHistoryPosition({ maxIdx: 0 }, { idx: 0, action: 'PUSH' });

    expect(next.canGoBack).toBe(false);
    expect(next.canGoForward).toBe(false);
  });

  it('fails closed when the router does not expose an index', () => {
    // A memory router, or a host that stripped history state. A disabled button
    // beats one that navigates somewhere unexpected.
    expect(reduceHistoryPosition({ maxIdx: 9 }, { idx: null, action: 'POP' })).toEqual(UNAVAILABLE);
    expect(reduceHistoryPosition({ maxIdx: 9 }, { idx: -1, action: 'POP' })).toEqual(UNAVAILABLE);
    expect(reduceHistoryPosition({ maxIdx: 9 }, { idx: NaN, action: 'PUSH' })).toEqual(UNAVAILABLE);
  });

  it('survives a missing prior ceiling', () => {
    const next = reduceHistoryPosition({ maxIdx: NaN }, { idx: 2, action: 'POP' });

    expect(next.maxIdx).toBe(2);
    expect(next.canGoForward).toBe(false);
  });
});
