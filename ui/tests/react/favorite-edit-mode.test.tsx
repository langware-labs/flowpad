import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Browseable } from '@src/components/browseable-tree/types';

// ── Shared module mocks ──────────────────────────────────────────────────────
// Controllable favorites state for FavoriteStar (toggle adds/removes, returns
// the created bookmark on add / null on remove — the new return contract).
const fav = vi.hoisted(() => {
  const state: { current: { id: string; name: string } | null } = { current: null };
  return {
    state,
    toggleFavorite: vi.fn((ref: { title: string }) => {
      if (state.current) {
        state.current = null;
        return Promise.resolve(null);
      }
      state.current = { id: 'bk-new', name: ref.title };
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
// Stub the heavy shared menu; echo the id-based selection so we can assert it.
vi.mock('@src/components/favorites/FavoritesMenu', async () => {
  const { createElement } = await import('react');
  return {
    FavoritesMenu: (p: { selectedKey?: string }) =>
      createElement('div', { 'data-testid': 'fav-menu', 'data-selected': p.selectedKey ?? '' }),
  };
});
// Stable dock so useCloseOnNavigate / BrowseableGrid default nav don't need a provider.
vi.mock('@src/navigation/useDockNavigation', () => ({
  useCurrentDock: () => ({ toString: () => 'DOCK' }),
  useDockNavigation: () => ({ navigation: { openDock: vi.fn() }, currentDock: { toString: () => 'DOCK' } }),
}));

import { BrowseableGrid } from '@src/components/browseable-tree/BrowseableGrid';
import { FavoritesEditDialog } from '@src/components/favorites/FavoritesEditDialog';
import { FavoriteStar } from '@src/components/favorites/FavoriteStar';
import { TooltipProvider } from '@src/components/ui/tooltip';

const renderStar = (props: React.ComponentProps<typeof FavoriteStar>) =>
  render(
    <TooltipProvider>
      <FavoriteStar {...props} />
    </TooltipProvider>,
  );

// ── Part B: id-based selection in the grid ───────────────────────────────────
describe('BrowseableGrid — id-based selectedKey highlight', () => {
  afterEach(cleanup);
  const node = (id: string, key: string): Browseable => ({
    kind: 'favorite',
    id,
    label: `Fav ${id}`,
    icon: <span />,
    hasChildren: false,
    pointer: null, // non-navigable — activePointer could never select it
    selectionKey: key,
  });

  it('highlights the tile whose selectionKey matches, even with no pointer', () => {
    render(<BrowseableGrid roots={[node('n1', 'bk1'), node('n2', 'bk2')]} selectedKey="bk1" />);
    expect(screen.getByRole('button', { name: 'Fav n1' }).className).toContain('border-primary');
    expect(screen.getByRole('button', { name: 'Fav n2' }).className).not.toContain('border-primary');
  });

  it('highlights nothing when selectedKey is unset', () => {
    render(<BrowseableGrid roots={[node('n1', 'bk1')]} />);
    expect(screen.getByRole('button', { name: 'Fav n1' }).className).not.toContain('border-primary');
  });
});

// ── Part C: the edit dialog does not auto-close, forwards selection ───────────
describe('FavoritesEditDialog', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders the shared menu with the pre-selected favorite and does not idle-close', () => {
    vi.useFakeTimers();
    const onOpenChange = vi.fn();
    render(<FavoritesEditDialog open onOpenChange={onOpenChange} selectedFavoriteId="bk-42" />);
    expect(screen.getByText('Edit favorites')).toBeInTheDocument();
    expect(screen.getByTestId('fav-menu').getAttribute('data-selected')).toBe('bk-42');
    // No idle timer here (unlike the LeftSlider): advancing time must not close it.
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(screen.getByTestId('fav-menu')).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

// ── Part D: the 5s edit window on the star ───────────────────────────────────
describe('FavoriteStar — post-creation edit window', () => {
  beforeEach(() => {
    fav.state.current = null;
    fav.toggleFavorite.mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('morphs to edit mode after favoriting; a click opens the dialog instead of un-favoriting', async () => {
    renderStar({ entityType: 'asset', entityId: 'a1', title: 'My Asset' });
    fireEvent.click(screen.getByRole('button', { name: 'Add to favorites' }));

    // After the async create resolves, the star is in edit mode.
    const editBtn = await screen.findByRole('button', { name: 'Edit favorite' });
    expect(fav.toggleFavorite).toHaveBeenCalledTimes(1);

    // Clicking during the window opens the dialog (does NOT toggle/remove).
    fireEvent.click(editBtn);
    await waitFor(() => expect(screen.getByTestId('fav-menu')).toBeInTheDocument());
    expect(screen.getByTestId('fav-menu').getAttribute('data-selected')).toBe('bk-new');
    expect(fav.toggleFavorite).toHaveBeenCalledTimes(1); // no second call → not removed
  });

  it('reverts to the plain star after the 5s window and then a click removes', async () => {
    vi.useFakeTimers();
    renderStar({ entityType: 'asset', entityId: 'a1', title: 'My Asset' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add to favorites' }));
      await Promise.resolve(); // flush the awaited toggleFavorite
    });
    expect(screen.getByRole('button', { name: 'Edit favorite' })).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    // Reverted to the amber star (favorited), edit glyph gone.
    expect(screen.queryByRole('button', { name: 'Edit favorite' })).not.toBeInTheDocument();
    const star = screen.getByRole('button', { name: /Favorited/ });

    // A click now removes (second toggle call).
    await act(async () => {
      fireEvent.click(star);
      await Promise.resolve();
    });
    expect(fav.toggleFavorite).toHaveBeenCalledTimes(2);
  });
});
