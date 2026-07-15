import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Bookmark, BookmarkType } from '@sdk';
import type { Browseable } from '@src/components/browseable-tree/types';

// ── Shared module mocks ──────────────────────────────────────────────────────
// useFavorites pulls the live bookmark list + the active project; stub both so
// we can drive a fixed tree. `refetch` is a spy because "markOpened must NOT
// refetch" is itself a design decision under test.
const h = vi.hoisted(() => ({
  bookmarks: [] as Bookmark[],
  refetch: vi.fn(),
  notifyEntityChanged: vi.fn(),
  save: vi.fn(() => Promise.resolve()),
}));

vi.mock('@src/hooks/use-project-bookmarks', () => ({
  useProjectBookmarks: () => ({ data: h.bookmarks, refetch: h.refetch, excludeBookmarks: vi.fn() }),
}));
vi.mock('@sdk/react/hooks', () => ({
  useProject: () => ({ project: { id: 'p1' } }),
}));
vi.mock('@sdk', async () => {
  const actual = await vi.importActual<typeof import('@sdk')>('@sdk');
  return { ...actual, dataManager: { notifyEntityChanged: h.notifyEntityChanged } };
});
// Stable dock so BrowseableGrid's default navigate doesn't need a Router.
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock: vi.fn() }, currentDock: { toString: () => 'DOCK' } }),
}));

const { useFavorites } = await import('@src/hooks/use-favorites');
const { BrowseableGrid } = await import('@src/components/browseable-tree/BrowseableGrid');

const ID = {
  folder: '00000000-0000-4000-8000-000000000001',
  opened: '00000000-0000-4000-8000-000000000011',
  fresh: '00000000-0000-4000-8000-000000000012',
};

function bookmarkWithCounter(id: string, counter?: number): Bookmark {
  const b = new Bookmark({
    id,
    bookmark_type: BookmarkType.FAVORITE,
    title: id,
    parent_id: ID.folder,
    counter,
  });
  b.save = h.save;
  return b;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ── markOpened: the reactivity contract ──────────────────────────────────────
describe('markOpened', () => {
  it('increments counter from absent (the pre-existing-row case)', async () => {
    const b = bookmarkWithCounter(ID.fresh); // counter undefined, as on every legacy row
    h.bookmarks = [b];
    const { result } = renderHook(() => useFavorites());

    await result.current.markOpened(b);

    expect(b.counter).toBe(1);
  });

  it('notifies subscribers synchronously — this, not the WS echo, ticks the badge', () => {
    const b = bookmarkWithCounter(ID.fresh);
    h.bookmarks = [b];
    const { result } = renderHook(() => useFavorites());

    void result.current.markOpened(b);

    // Notified with the entity itself, before/independent of the save resolving.
    expect(h.notifyEntityChanged).toHaveBeenCalledWith(b);
  });

  it('persists but does NOT refetch — it fires on every click, unlike its neighbours', async () => {
    const b = bookmarkWithCounter(ID.fresh);
    h.bookmarks = [b];
    const { result } = renderHook(() => useFavorites());

    await result.current.markOpened(b);

    expect(h.save).toHaveBeenCalledOnce();
    expect(h.refetch).not.toHaveBeenCalled();
  });

  it('two rapid opens both land — they mutate the one shared cached instance', async () => {
    const b = bookmarkWithCounter(ID.fresh);
    h.bookmarks = [b];
    const { result } = renderHook(() => useFavorites());

    await result.current.markOpened(b);
    await result.current.markOpened(b);

    expect(b.counter).toBe(2);
  });

  it('an opened bookmark is no longer unopened', async () => {
    const opened = bookmarkWithCounter(ID.opened, 3);
    const fresh = bookmarkWithCounter(ID.fresh, 0);
    h.bookmarks = [opened, fresh];
    const { result } = renderHook(() => useFavorites());

    await result.current.markOpened(fresh);

    // Both now count as opened — nothing left for a badge to report.
    expect(h.bookmarks.every((b) => (b.counter ?? 0) > 0)).toBe(true);
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

  it('fires on the POINTER arm — the case a bare `activate` hook would miss', () => {
    const onOpen = vi.fn();
    const navigate = vi.fn();
    const pointer = { viewType: 'editor', pointer: 'x' } as never;
    render(<BrowseableGrid roots={[node({ pointer, onOpen })]} onNavigate={navigate} />);

    fireEvent.click(screen.getByText('Tile'));

    expect(navigate).toHaveBeenCalledWith(pointer);
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

  it('navigation still happens when the usage stamp throws — onOpen can never block it', () => {
    const navigate = vi.fn();
    const pointer = { viewType: 'editor', pointer: 'x' } as never;
    const onOpen = () => {
      throw new Error('stamp exploded');
    };
    render(<BrowseableGrid roots={[node({ pointer, onOpen })]} onNavigate={navigate} />);

    try {
      fireEvent.click(screen.getByText('Tile'));
    } catch {
      // The throw propagates out of the handler; what matters is that it
      // happened AFTER dispatch, so navigation already went through.
    }

    expect(navigate).toHaveBeenCalledWith(pointer);
  });
});
