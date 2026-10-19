import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Bookmark, BookmarkType, dataManager } from '@sdk';
import type { Browseable } from '@src/components/browseable-tree/types';

// Stable dock so BrowseableGrid's default navigate doesn't need a Router.
vi.mock('@src/navigation/useDockNavigation', () => ({
  useCurrentDock: () => ({ toString: () => 'DOCK' }),
  useDockNavigation: () => ({ navigation: { openDock: vi.fn() }, currentDock: { toString: () => 'DOCK' } }),
}));

const { BrowseableGrid } = await import('@src/components/browseable-tree/BrowseableGrid');

const ID = { fresh: '00000000-0000-4000-8000-000000000012' };

/** A favorite with a stubbed save — markOpened is a pure entity mutation, so
 *  these need no hook, no provider and no module mocks. */
function favorite(counter?: number, save = vi.fn(() => Promise.resolve())): Bookmark {
  const b = new Bookmark({ id: ID.fresh, bookmark_type: BookmarkType.FAVORITE, title: 'fav', counter });
  b.save = save;
  return b;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ── Bookmark.markOpened: the reactivity contract ─────────────────────────────
describe('Bookmark.markOpened', () => {
  it('increments counter from absent (the pre-existing-row case)', async () => {
    const b = favorite(); // counter undefined, as on every row predating the field
    await b.markOpened();
    expect(b.counter).toBe(1);
  });

  it('increments rather than assigns — two opens reach 2', async () => {
    const b = favorite();
    await b.markOpened();
    await b.markOpened();
    expect(b.counter).toBe(2);
  });

  it('notifies subscribers — this, not the save WS echo, is what ticks the badge', async () => {
    const notify = vi.spyOn(dataManager, 'notifyEntityChanged').mockImplementation(() => {});
    const b = favorite();

    await b.markOpened();

    expect(notify).toHaveBeenCalledWith(b);
  });

  it('persists the bump', async () => {
    vi.spyOn(dataManager, 'notifyEntityChanged').mockImplementation(() => {});
    const save = vi.fn(() => Promise.resolve());
    const b = favorite(undefined, save);

    await b.markOpened();

    expect(save).toHaveBeenCalledOnce();
  });
});

// ── Bookmark.markSeen: clears the badge without counting as an open ──────────
describe('Bookmark.markSeen', () => {
  it('sets its own flag and leaves the open count alone — a hover is not an open', async () => {
    vi.spyOn(dataManager, 'notifyEntityChanged').mockImplementation(() => {});
    const b = favorite(); // counter undefined = never opened

    await b.markSeen();
    await b.markOpened();

    expect(b.seen).toBe(true);
    expect(b.counter).toBe(1); // the open, and only the open
  });

  it('is idempotent — a second sweep of the same menu writes nothing', async () => {
    vi.spyOn(dataManager, 'notifyEntityChanged').mockImplementation(() => {});
    const save = vi.fn(() => Promise.resolve());
    const b = favorite(undefined, save);

    await b.markSeen();
    await b.markSeen();

    expect(save).toHaveBeenCalledOnce();
  });

  it('is a no-op on an already-opened favorite — nothing left to clear', async () => {
    const notify = vi.spyOn(dataManager, 'notifyEntityChanged').mockImplementation(() => {});
    const save = vi.fn(() => Promise.resolve());
    const b = favorite(3, save);

    await b.markSeen();

    expect(b.seen).toBeFalsy();
    expect(save).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('notifies subscribers — this, not the save WS echo, is what clears the badge', async () => {
    const notify = vi.spyOn(dataManager, 'notifyEntityChanged').mockImplementation(() => {});
    const b = favorite();

    await b.markSeen();

    expect(notify).toHaveBeenCalledWith(b);
  });
});

// ── onOpen: fires from BOTH arms, and only when something opened ─────────────
describe('BrowseableGrid onOpen', () => {
  const node = (over: Partial<Browseable>): Browseable => ({
    id: 'n1',
    kind: 'favorite',
    label: 'Tile',
    hasChildren: false,
    pointer: null,
    ...over,
  });
  const POINTER = { viewType: 'editor', pointer: 'x' } as never;

  it('fires on the POINTER arm — the case a bare `activate` hook would miss', () => {
    const onOpen = vi.fn();
    const navigate = vi.fn();
    render(<BrowseableGrid roots={[node({ pointer: POINTER, onOpen })]} onNavigate={navigate} />);

    fireEvent.click(screen.getByText('Tile'));

    expect(navigate).toHaveBeenCalledWith(POINTER);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('fires on the ACTIVATE arm', () => {
    const onOpen = vi.fn();
    const activate = vi.fn();
    render(<BrowseableGrid roots={[node({ activate, onOpen })]} />);

    fireEvent.click(screen.getByText('Tile'));

    expect(activate).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('fires only AFTER dispatch, so a throwing stamp cannot eat the navigation', () => {
    const onOpen = vi.fn();
    const navigate = vi.fn();
    render(<BrowseableGrid roots={[node({ pointer: POINTER, onOpen })]} onNavigate={navigate} />);

    fireEvent.click(screen.getByText('Tile'));

    expect(navigate.mock.invocationCallOrder[0]).toBeLessThan(onOpen.mock.invocationCallOrder[0]);
  });

  it('does NOT fire for a non-actionable row — a broken favorite was never opened', () => {
    const onOpen = vi.fn();
    render(<BrowseableGrid roots={[node({ onOpen })]} />); // no pointer, no activate

    fireEvent.click(screen.getByText('Tile'));

    expect(onOpen).not.toHaveBeenCalled();
  });

  it('does NOT fire for a container — clicking a folder expands it, it opens nothing', () => {
    const onOpen = vi.fn();
    render(
      <BrowseableGrid
        roots={[node({ label: 'Folder', hasChildren: true, listChildren: () => Promise.resolve([]), onOpen })]}
      />,
    );

    fireEvent.click(screen.getByText('Folder'));

    expect(onOpen).not.toHaveBeenCalled();
  });
});
