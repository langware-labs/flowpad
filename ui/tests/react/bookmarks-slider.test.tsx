import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Bookmark } from '@sdk';
import { allScope, filterScope, projectScope, userScope } from '@src/lib/scope-filter';
import { bookmarkInScope } from '@src/lib/bookmark-scope';
import { useIdleAutoClose } from '@src/hooks/use-idle-auto-close';
import { LeftSlider } from '@src/components/ui/left-slider';

// ── Part 2: scope predicate over favorites ───────────────────────────────────
describe('bookmarkInScope', () => {
  const bmP1 = new Bookmark({ project_id: 'p1' });
  const bmP2 = new Bookmark({ project_id: 'p2' });
  const bmPersonal = new Bookmark({}); // no project_id → personal

  it('all scope shows everything', () => {
    for (const b of [bmP1, bmP2, bmPersonal]) {
      expect(bookmarkInScope(b, allScope(), 'p1')).toBe(true);
    }
  });

  it('project scope shows only the active project', () => {
    expect(bookmarkInScope(bmP1, projectScope('p1'), 'p1')).toBe(true);
    expect(bookmarkInScope(bmP2, projectScope('p1'), 'p1')).toBe(false);
    expect(bookmarkInScope(bmPersonal, projectScope('p1'), 'p1')).toBe(false);
  });

  it('user scope shows only personal (project-less) favorites', () => {
    expect(bookmarkInScope(bmPersonal, userScope(), 'p1')).toBe(true);
    expect(bookmarkInScope(bmP1, userScope(), 'p1')).toBe(false);
  });

  it('filter scope shows selected projects (+ personal when user flag on)', () => {
    expect(bookmarkInScope(bmP2, filterScope(false, ['p2']), 'p1')).toBe(true);
    expect(bookmarkInScope(bmP1, filterScope(false, ['p2']), 'p1')).toBe(false);
    expect(bookmarkInScope(bmPersonal, filterScope(false, ['p2']), 'p1')).toBe(false);
    expect(bookmarkInScope(bmPersonal, filterScope(true, ['p2']), 'p1')).toBe(true);
  });
});

// ── Part 1: idle auto-close hook ─────────────────────────────────────────────
describe('useIdleAutoClose', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires onIdle after the idle window elapses', () => {
    const onIdle = vi.fn();
    renderHook(() => useIdleAutoClose(true, onIdle, 5000));
    expect(onIdle).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(4999));
    expect(onIdle).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('activity resets the timer', () => {
    const onIdle = vi.fn();
    renderHook(() => useIdleAutoClose(true, onIdle, 5000));
    act(() => vi.advanceTimersByTime(4000));
    act(() => window.dispatchEvent(new Event('pointermove')));
    act(() => vi.advanceTimersByTime(4000)); // 8s total, but 4s since reset
    expect(onIdle).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1000));
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('does not arm when inactive', () => {
    const onIdle = vi.fn();
    renderHook(() => useIdleAutoClose(false, onIdle, 5000));
    act(() => vi.advanceTimersByTime(10000));
    expect(onIdle).not.toHaveBeenCalled();
  });
});

// ── Part 1: LeftSlider primitive ─────────────────────────────────────────────
describe('LeftSlider', () => {
  afterEach(cleanup);

  it('renders title, headerRight, and children when open', () => {
    render(
      <LeftSlider open onOpenChange={() => {}} title="My Slider" headerRight={<div data-testid="hdr" />}>
        <div data-testid="body" />
      </LeftSlider>,
    );
    expect(screen.getByText('My Slider')).toBeInTheDocument();
    expect(screen.getByTestId('hdr')).toBeInTheDocument();
    expect(screen.getByTestId('body')).toBeInTheDocument();
  });

  it('renders nothing when closed', () => {
    render(
      <LeftSlider open={false} onOpenChange={() => {}} title="My Slider">
        <div data-testid="body" />
      </LeftSlider>,
    );
    expect(screen.queryByTestId('body')).not.toBeInTheDocument();
  });

  it('closes on Escape', () => {
    const onOpenChange = vi.fn();
    render(
      <LeftSlider open onOpenChange={onOpenChange} title="My Slider">
        <div data-testid="body" />
      </LeftSlider>,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('closes on the header close button', () => {
    const onOpenChange = vi.fn();
    render(
      <LeftSlider open onOpenChange={onOpenChange} title="My Slider">
        <div data-testid="body" />
      </LeftSlider>,
    );
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

// ── Part 2: BookmarksSlider wiring (isolated via mocks) ───────────────────────
const h = vi.hoisted(() => ({ openDock: vi.fn(), dock: 'DOCK' }));

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({
    navigation: { openDock: h.openDock },
    currentDock: { toString: () => h.dock },
  }),
}));
vi.mock('@src/hooks/useProject', () => ({
  useProject: () => ({ project: { id: 'p1', name: 'P1', getDisplayName: () => 'P1' } }),
}));
vi.mock('@src/hooks/use-default-scope-filter', () => ({
  useDefaultScopeFilter: () => [{ mode: 'all' }, vi.fn(), 'p1'],
}));
vi.mock('@src/components/browseable-tree/adapters/useFavoritesRoots', () => ({
  useFavoritesRoots: () => ({ roots: [], onDropToBackground: vi.fn(), onReorderRoot: vi.fn() }),
}));
vi.mock('@src/components/scope-filter/ScopeFilterIconBar', async () => {
  const { createElement } = await import('react');
  return { ScopeFilterIconBar: () => createElement('div', { 'data-testid': 'scope-bar' }) };
});
vi.mock('@src/components/browseable-tree/BrowseableGrid', async () => {
  const { createElement } = await import('react');
  return {
    BrowseableGrid: (props: { onNavigate?: (p: unknown) => void }) =>
      createElement('button', {
        'data-testid': 'grid-tile',
        onClick: () => props.onNavigate?.('PTR'),
      }),
  };
});

// Imported after the mocks so the module graph resolves to the stubs.
const { BookmarksSlider } = await import('@src/components/bookmarks-slider/BookmarksSlider');

describe('BookmarksSlider', () => {
  beforeEach(() => {
    h.openDock.mockClear();
    h.dock = 'DOCK';
  });
  afterEach(cleanup);

  it('pins the scope filter on top of the bookmark grid (shared FavoritesMenu)', () => {
    render(<BookmarksSlider open onOpenChange={() => {}} />);
    expect(screen.getByTestId('scope-bar')).toBeInTheDocument();
    expect(screen.getByTestId('grid-tile')).toBeInTheDocument();
  });

  it('closes the slider when navigation changes the dock (any favorite click arm)', () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(<BookmarksSlider open onOpenChange={onOpenChange} />);
    // Simulate a navigation: the dock identity changes → useCloseOnNavigate fires.
    h.dock = 'DOCK2';
    rerender(<BookmarksSlider open onOpenChange={onOpenChange} />);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('closes the slider when the window loses focus', () => {
    const onOpenChange = vi.fn();
    render(<BookmarksSlider open onOpenChange={onOpenChange} />);
    fireEvent.blur(window);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
