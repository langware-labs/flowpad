/**
 * A tab's own bookmark star, and the "point to" flight it plays.
 *
 * Pinned: the star is the navigation bar's star for THAT tab (same FavoriteRef
 * as `favoriteTargetForDock` gives the bar), it hides until hover while off,
 * turning it ON — and only on — flies the chip into the bar's star, and the
 * flight leaves the chip on screen (point-to), where minimize hides its source.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Tab } from '@sdk';

const fav = vi.hoisted(() => {
  const state: { current: { id: string } | null } = { current: null };
  return {
    state,
    toggleFavorite: vi.fn(() => {
      state.current = state.current ? null : { id: 'bk-1' };
      return Promise.resolve(state.current);
    }),
  };
});
vi.mock('@src/hooks/use-favorites', () => ({
  useFavorites: () => ({
    isFavorited: () => fav.state.current,
    toggleFavorite: fav.toggleFavorite,
    renameFavorite: vi.fn(),
  }),
}));
const pointToBookmarks = vi.hoisted(() => vi.fn());
vi.mock('@src/lib/minimize-to-element', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@src/lib/minimize-to-element')>()),
  animatePointToBookmarks: pointToBookmarks,
}));

import { TabFavoriteStar } from '@src/components/tabs/TabFavoriteStar';
import { TooltipProvider } from '@src/components/ui/tooltip';
import { animateMinimizeToElement, animatePointTo } from '@src/lib/minimize-to-element';
import { tabItem } from '@src/tabs/tab-row-item';

const PROC = '8c98d9c8-4295-4ac4-8560-788d762bd89a';
const favorite = { entityType: 'agentic_process', entityId: PROC, title: 'hi' };

beforeEach(() => {
  fav.state.current = null;
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('TabFavoriteStar', () => {
  const chip = document.createElement('div');
  const renderStar = () =>
    render(
      <TooltipProvider>
        <TabFavoriteStar favorite={favorite} chip={() => chip} />
      </TooltipProvider>,
    );

  it('off: hidden until the chip is hovered', () => {
    renderStar();
    const star = screen.getByTestId('tab-favorite-star');
    expect(star.className).toContain('opacity-0');
    expect(star.className).toContain('group-hover:opacity-60');
    expect(star.dataset.favorited).toBeUndefined();
  });

  it('turning it ON points the chip at the bookmarks star', async () => {
    renderStar();
    fireEvent.click(screen.getByTestId('tab-favorite-star').querySelector('button')!);

    await waitFor(() => expect(pointToBookmarks).toHaveBeenCalledWith(chip));
    expect(fav.toggleFavorite).toHaveBeenCalledWith(expect.objectContaining(favorite));
  });

  it('on: always shown, and turning it OFF flies nothing', async () => {
    fav.state.current = { id: 'bk-1' };
    renderStar();
    const star = screen.getByTestId('tab-favorite-star');
    expect(star.className).not.toContain('opacity-0');
    expect(star.dataset.favorited).toBe('true');

    fireEvent.click(star.querySelector('button')!);
    await waitFor(() => expect(fav.toggleFavorite).toHaveBeenCalledTimes(1));
    expect(pointToBookmarks).not.toHaveBeenCalled();
  });

  it('a press on the star never reaches the chip (no drag, no select)', () => {
    const onPointerDown = vi.fn();
    const onClick = vi.fn();
    render(
      <TooltipProvider>
        <div onPointerDown={onPointerDown} onClick={onClick}>
          <TabFavoriteStar favorite={favorite} chip={() => chip} />
        </div>
      </TooltipProvider>,
    );
    const button = screen.getByTestId('tab-favorite-star').querySelector('button')!;
    fireEvent.pointerDown(button);
    fireEvent.click(button);
    expect(onPointerDown).not.toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('point-to vs minimize', () => {
  const box = (x: number) => ({ left: x, top: 0, width: 100, height: 20, x, y: 0, right: x + 100, bottom: 20 });
  const mount = (x: number) => {
    const el = document.createElement('div');
    el.getBoundingClientRect = () => box(x) as DOMRect;
    document.body.appendChild(el);
    return el;
  };
  const animate = vi.fn(() => ({}) as Animation);
  beforeEach(() => {
    animate.mockClear();
    HTMLElement.prototype.animate = animate;
  });

  it('point-to flies a copy and leaves the source on screen', () => {
    const source = mount(0);
    const target = mount(500);
    animatePointTo(source, target);
    expect(animate).toHaveBeenCalledTimes(1);
    expect(source.style.visibility).toBe('');
  });

  it('minimize still hides its source (it is about to unmount)', () => {
    const source = mount(0);
    animateMinimizeToElement(source, mount(500));
    expect(source.style.visibility).toBe('hidden');
  });
});

describe('tabItem → favorite', () => {
  it('a session tab carries the same ref the bar gives its dock: the process typeid', () => {
    const tab = new Tab({
      id: '00000000-0000-4000-8000-0000000000a1',
      pointer: JSON.stringify({ viewType: 'shell', pointer: `agentic_process-${PROC}` }),
      target_type: 'agentic_process',
      target_id: PROC,
      name: 'hi',
    } as never);
    expect(tabItem(tab).favorite).toEqual({ entityType: 'agentic_process', entityId: PROC, title: 'hi' });
  });
});
