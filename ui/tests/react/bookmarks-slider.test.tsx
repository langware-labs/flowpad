import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Bookmark } from '@sdk';
import { allScope, filterScope, projectScope, userScope } from '@src/lib/scope-filter';
import { bookmarkInScope } from '@src/lib/bookmark-scope';
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

  it('project scope shows the active project, and keeps personal favorites', () => {
    expect(bookmarkInScope(bmP1, projectScope('p1'), 'p1')).toBe(true);
    expect(bookmarkInScope(bmP2, projectScope('p1'), 'p1')).toBe(false);
    // An unscoped favorite is personal/global — it belongs in EVERY scope.
    // This used to be false, which emptied the whole bookmarks desktop: every
    // favorite predating project_id stamping is unscoped, and defaultScopeFilter
    // picks project scope whenever a project is active.
    expect(bookmarkInScope(bmPersonal, projectScope('p1'), 'p1')).toBe(true);
  });

  it('user scope hides project-stamped favorites', () => {
    expect(bookmarkInScope(bmPersonal, userScope(), 'p1')).toBe(true);
    expect(bookmarkInScope(bmP1, userScope(), 'p1')).toBe(false);
  });

  it('filter scope shows selected projects, and always keeps personal favorites', () => {
    expect(bookmarkInScope(bmP2, filterScope(false, ['p2']), 'p1')).toBe(true);
    expect(bookmarkInScope(bmP1, filterScope(false, ['p2']), 'p1')).toBe(false);
    // Personal favorites ride along regardless of the `user` flag — the flag
    // gates project-less RECORDS generally, but a favorite with no project_id
    // is not "someone else's personal", it's this user's own desktop.
    expect(bookmarkInScope(bmPersonal, filterScope(false, ['p2']), 'p1')).toBe(true);
    expect(bookmarkInScope(bmPersonal, filterScope(true, ['p2']), 'p1')).toBe(true);
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
  useCurrentDock: () => ({ toString: () => h.dock }),
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
  useFavoritesTreeRoots: () => [],
}));
vi.mock('@src/components/scope-filter/ScopeFilterIconBar', async () => {
  const { createElement } = await import('react');
  return { ScopeFilterIconBar: () => createElement('div', { 'data-testid': 'scope-bar' }) };
});
// The slider is a MENU: it renders the tree, never the icon grid (that stays
// the Edit dialog's surface). Stub the tree and assert on it.
vi.mock('@src/components/browseable-tree/BrowseableTree', async () => {
  const { createElement } = await import('react');
  return {
    BrowseableTree: (props: { onNavigate?: (p: unknown) => void; hoverExpandMs?: number }) =>
      createElement('button', {
        'data-testid': 'tree-row',
        'data-hover-expand-ms': props.hoverExpandMs,
        onClick: () => props.onNavigate?.('PTR'),
      }),
  };
});

// Imported after the mocks so the module graph resolves to the stubs.
const { BookmarksSlider } = await import('@src/components/bookmarks-slider/BookmarksSlider');

// The panel's hover arm; these cases exercise the OTHER close arms.
const noHover = { onPointerEnter: () => {}, onPointerLeave: () => {} };

describe('BookmarksSlider', () => {
  beforeEach(() => {
    h.openDock.mockClear();
    h.dock = 'DOCK';
  });
  afterEach(cleanup);

  it('renders the tree menu with hover-expand, scope filter in the slider header', () => {
    render(<BookmarksSlider open onOpenChange={() => {}} hoverProps={noHover} />);
    expect(screen.getByTestId('scope-bar')).toBeInTheDocument();
    const tree = screen.getByTestId('tree-row');
    expect(tree).toBeInTheDocument();
    // Hover-expand is opt-in per surface; the menu is the one that opts in.
    expect(tree).toHaveAttribute('data-hover-expand-ms', '150');
  });

  it('closes the slider when navigation changes the dock (any favorite click arm)', () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(<BookmarksSlider open onOpenChange={onOpenChange} hoverProps={noHover} />);
    // Simulate a navigation: the dock identity changes → useCloseOnNavigate fires.
    h.dock = 'DOCK2';
    rerender(<BookmarksSlider open onOpenChange={onOpenChange} hoverProps={noHover} />);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('closes the slider when the window loses focus', () => {
    const onOpenChange = vi.fn();
    render(<BookmarksSlider open onOpenChange={onOpenChange} hoverProps={noHover} />);
    fireEvent.blur(window);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
