/**
 * The navigation bar's bookmarks button: one glyph, two gestures.
 *
 * Click bookmarks the current thing; hover browses the ones you have. The whole
 * point of the component is that those never collide, so that is what this
 * pins — plus the one thing that quietly breaks if the star's hover card is
 * removed rather than suppressed: right-click Rename.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fav = vi.hoisted(() => {
  const state: { current: { id: string; name: string } | null } = { current: null };
  return {
    state,
    toggleFavorite: vi.fn((ref: { title: string }) => {
      if (state.current) {
        state.current = null;
        return Promise.resolve(null);
      }
      state.current = { id: 'bk-1', name: ref.title };
      return Promise.resolve(state.current);
    }),
    renameFavorite: vi.fn(),
  };
});
vi.mock('@src/hooks/use-favorites', () => ({
  useFavorites: () => ({
    isFavorited: () => fav.state.current,
    toggleFavorite: fav.toggleFavorite,
    renameFavorite: fav.renameFavorite,
  }),
}));
vi.mock('@src/hooks/use-unopened-favorites-count', () => ({ useUnopenedFavoritesCount: () => 3 }));
// Desk runtime: the hub has no `bookmark` entity, so the menu is withheld there.
vi.mock('@src/navigation/hub-runtime', () => ({ isHubOnly: () => false }));
// The panel's contents are covered by their own tests; here only its PRESENCE
// matters, so stub it and skip the favorites tree's data layer entirely.
vi.mock('@src/components/bookmarks-slider/BookmarksSlider', () => ({
  BookmarksSlider: ({ open }: { open: boolean }) => (open ? <div data-testid="bookmarks-panel" /> : null),
}));

import { HOVER_CLOSE_GRACE_MS, HOVER_DWELL_MS } from '@src/hooks/use-hover-intent';
import { BookmarksStarButton } from '@src/components/top-nav-bar/BookmarksStarButton';
import { TooltipProvider } from '@src/components/ui/tooltip';

const FAVORITE = { entityType: 'markdown', entityId: 'a1', title: 'Design notes' };

function renderButton() {
  return render(
    <TooltipProvider>
      <BookmarksStarButton favorite={FAVORITE} />
    </TooltipProvider>,
  );
}

/**
 * Hover, the way it actually reaches the component.
 *
 * Two jsdom facts make the obvious `fireEvent.pointerEnter(el, {pointerType})`
 * a no-op here, and BOTH silently pass a test that asserts "nothing opened":
 *  - React derives `onPointerEnter` from the delegated `pointerover`, and a
 *    dispatched `pointerenter` does not bubble, so the handler never runs;
 *  - jsdom has no `PointerEvent`, so a `pointerType` passed through fireEvent's
 *    init dict is dropped — and `useHoverIntent` ignores anything that isn't
 *    `'mouse'`.
 * Defining the property on a real MouseEvent is what survives both.
 */
function pointerOver(el: Element, pointerType: string) {
  const ev = new MouseEvent('pointerover', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'pointerType', { value: pointerType });
  fireEvent(el, ev);
}
const mouseEnter = (el: Element) => pointerOver(el, 'mouse');

/** React derives `onPointerLeave` from `pointerout`, for the same reason. */
function pointerOut(el: Element) {
  const ev = new MouseEvent('pointerout', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'pointerType', { value: 'mouse' });
  fireEvent(el, ev);
}
const trigger = () => screen.getByTestId('top-nav-bookmarks-star');

beforeEach(() => {
  fav.state.current = null;
  fav.toggleFavorite.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the bookmarks star', () => {
  it('opens the menu once the pointer has RESTED, not on arrival', () => {
    vi.useFakeTimers();
    renderButton();

    mouseEnter(trigger());
    act(() => void vi.advanceTimersByTime(HOVER_DWELL_MS - 1));
    expect(screen.queryByTestId('bookmarks-panel')).toBeNull();

    act(() => void vi.advanceTimersByTime(1));
    expect(screen.getByTestId('bookmarks-panel')).toBeTruthy();
  });

  it('closes once the pointer has been away for the grace period', () => {
    vi.useFakeTimers();
    renderButton();
    mouseEnter(trigger());
    act(() => void vi.advanceTimersByTime(HOVER_DWELL_MS));

    pointerOut(trigger());
    act(() => void vi.advanceTimersByTime(HOVER_CLOSE_GRACE_MS));

    expect(screen.queryByTestId('bookmarks-panel')).toBeNull();
  });

  it('ignores a touch tap, which would otherwise open AND toggle', () => {
    vi.useFakeTimers();
    renderButton();

    pointerOver(trigger(), 'touch');
    act(() => void vi.advanceTimersByTime(HOVER_DWELL_MS * 2));

    expect(screen.queryByTestId('bookmarks-panel')).toBeNull();
  });

  it('toggles the favorite on click without opening the menu', () => {
    renderButton();

    fireEvent.click(screen.getByRole('button', { name: 'Add to favorites' }));

    expect(fav.toggleFavorite).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('bookmarks-panel')).toBeNull();
  });

  it('carries the unopened count', () => {
    renderButton();

    expect(trigger().textContent).toContain('3');
  });

  it('keeps right-click Rename working — the card is suppressed, not removed', async () => {
    // The regression this guards: the rename input lives INSIDE the star's hover
    // card. Deleting that card to free up hover would leave Rename firing state
    // nothing renders, silently losing the only route to renaming here.
    fav.state.current = { id: 'bk-1', name: 'Design notes' };
    renderButton();

    fireEvent.contextMenu(screen.getByRole('button', { name: /Favorited/ }));
    const rename = await screen.findByText('Rename');
    fireEvent.click(rename);

    expect(await screen.findByDisplayValue('Design notes')).toBeTruthy();
  });

  it('does not open its own hover card, which would sit on top of the menu', () => {
    vi.useFakeTimers();
    fav.state.current = { id: 'bk-1', name: 'Design notes' };
    renderButton();

    mouseEnter(screen.getByRole('button', { name: /Favorited/ }));
    // Well past the card's own 300ms open delay.
    act(() => void vi.advanceTimersByTime(400));

    expect(screen.queryByDisplayValue('Design notes')).toBeNull();
  });
});
