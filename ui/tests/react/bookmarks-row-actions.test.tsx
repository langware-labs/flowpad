import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Bookmark, BookmarkType } from '@sdk';

/**
 * Bookmarks row actions: a destructive action takes two clicks, sits on the
 * edge opposite the chevron, and is undoable for a short window before anything
 * is written. One store backs every favorites surface.
 */

const h = vi.hoisted(() => ({
  bookmarks: [] as unknown[],
  refetch: vi.fn(() => Promise.resolve()),
  notify: { info: vi.fn(), dismiss: vi.fn() },
}));

vi.mock('@src/hooks/use-project-bookmarks', () => ({
  useProjectBookmarks: () => ({ data: h.bookmarks, refetch: h.refetch }),
}));
vi.mock('@sdk/react/hooks', () => ({ useProject: () => ({ project: { id: 'p1' } }) }));
vi.mock('@src/notifications/notify', () => ({ notify: h.notify }));
vi.mock('@src/hooks/use-favorite-summaries', () => ({
  useFavoriteSummaries: () => ({}),
  summaryForBookmark: () => undefined,
}));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useCurrentDock: () => null,
  useDockNavigation: () => ({ navigation: { openDock: vi.fn() }, currentDock: null }),
}));

const { useFavorites } = await import('@src/hooks/use-favorites');
const { FAVORITES_UNDO_MS, flushPendingFavoriteDelete } = await import('@src/hooks/favorites-pending-delete');
const { runCommand } = await import('@src/notifications/commands');
const { useFavoritesRoots } = await import('@src/components/browseable-tree/adapters/useFavoritesRoots');
const { BrowseableTree, ToolbarButton } = await import('@src/components/browseable-tree/BrowseableTree');
const { TooltipProvider } = await import('@src/components/ui/tooltip');

// Fresh ids per test: committed ids stay hidden in the module store by design.
let seq = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

const deletes: string[] = [];
function folder(id: string, parent = '') {
  const b = new Bookmark({ id, bookmark_type: BookmarkType.FAVORITE_FOLDER, title: `folder-${id.slice(-3)}`, parent_id: parent });
  b.delete = () => {
    deletes.push(id);
    return Promise.resolve();
  };
  return b;
}
function leaf(id: string, parent = '', opened = false) {
  const b = new Bookmark({
    id,
    bookmark_type: BookmarkType.FAVORITE,
    title: `leaf-${id.slice(-3)}`,
    parent_id: parent,
    counter: opened ? 1 : 0,
    // A resolvable markdown target, so the leaf passes the navigability gate.
    data: { entity_type: 'markdown', entity_id: nextId() },
  });
  b.delete = () => {
    deletes.push(id);
    return Promise.resolve();
  };
  return b;
}
const ids = (rows: { id?: string }[]) => rows.map((b) => b.id);

beforeEach(() => {
  vi.useFakeTimers();
  deletes.length = 0;
});
afterEach(async () => {
  await flushPendingFavoriteDelete();
  vi.useRealTimers();
  vi.clearAllMocks();
  cleanup();
});

describe('favorites undo window', () => {
  it('hides a removed favorite at once and deletes it only when the window closes', async () => {
    const a = leaf(nextId());
    const b = leaf(nextId());
    h.bookmarks = [a, b];
    const { result, rerender } = renderHook(() => useFavorites());

    act(() => result.current.removeFavorite(a));
    rerender();
    expect(ids(result.current.favorites)).toEqual([b.id]);
    expect(deletes).not.toContain(a.id);
    expect(h.notify.info).toHaveBeenCalledWith(
      expect.objectContaining({ actions: [expect.objectContaining({ command: 'favorites.undo' })] }),
    );

    await act(() => vi.advanceTimersByTimeAsync(FAVORITES_UNDO_MS));
    expect(deletes).toContain(a.id);
    // The toast pauses its own timer on hover; once the write happens its Undo
    // would be a dead button, so the commit takes it down.
    expect(h.notify.dismiss).toHaveBeenCalledWith('favorites-undo');
  });

  it('Undo brings the row back and writes nothing', async () => {
    const a = leaf(nextId());
    h.bookmarks = [a];
    const { result, rerender } = renderHook(() => useFavorites());

    act(() => result.current.removeFavorite(a));
    act(() => runCommand('favorites.undo', {}, { id: 'favorites-undo' }));
    rerender();
    expect(ids(result.current.favorites)).toEqual([a.id]);

    await act(() => vi.advanceTimersByTimeAsync(FAVORITES_UNDO_MS * 2));
    expect(deletes).not.toContain(a.id);
  });

  it('is shared: a pending row is hidden in every useFavorites() and survives a refetch', () => {
    const a = leaf(nextId());
    h.bookmarks = [a];
    const menu = renderHook(() => useFavorites());
    const desktop = renderHook(() => useFavorites());

    act(() => menu.result.current.removeFavorite(a));
    // A refetch hands back the same server rows — the row is still there.
    h.bookmarks = [a];
    desktop.rerender();
    menu.rerender();
    expect(ids(desktop.result.current.favorites)).toEqual([]);
    expect(ids(menu.result.current.favorites)).toEqual([]);
  });

  it('deleting a folder removes its whole subtree, leaves before folders, nothing promoted', async () => {
    const top = folder(nextId());
    const sub = folder(nextId(), top.id);
    const l1 = leaf(nextId(), top.id);
    const l2 = leaf(nextId(), sub.id);
    const outside = leaf(nextId());
    h.bookmarks = [top, sub, l1, l2, outside];
    const { result, rerender } = renderHook(() => useFavorites());

    act(() => result.current.deleteFolder(top));
    rerender();
    // Nothing of the subtree surfaces at the root while the delete is pending.
    expect(ids(result.current.rootFavorites)).toEqual([outside.id]);
    expect(ids(result.current.rootFolders)).toEqual([]);

    await act(() => vi.advanceTimersByTimeAsync(FAVORITES_UNDO_MS));
    expect(new Set(deletes.slice(0, 2))).toEqual(new Set([l1.id, l2.id]));
    expect(deletes.slice(2)).toEqual([sub.id, top.id]);
    expect(deletes).not.toContain(outside.id);
  });

  it('a second delete commits the first right away', () => {
    const a = leaf(nextId());
    const b = leaf(nextId());
    h.bookmarks = [a, b];
    const { result } = renderHook(() => useFavorites());

    act(() => result.current.removeFavorite(a));
    act(() => result.current.removeFavorite(b));
    expect(deletes).toContain(a.id);
    expect(deletes).not.toContain(b.id);
  });
});

describe('destructive toolbar button', () => {
  it('arms on the first click and runs on the second; leaving disarms', () => {
    const run = vi.fn();
    render(
      <ToolbarButton action={{ id: 'del', icon: <span>x</span>, label: 'Delete folder', run, destructive: true }} />,
    );
    const btn = screen.getByTestId('browseable-toolbar-del');

    fireEvent.click(btn);
    expect(run).not.toHaveBeenCalled();
    expect(btn.getAttribute('data-armed')).toBe('true');
    expect(btn.getAttribute('aria-label')).toBe('Confirm: Delete folder');

    fireEvent.pointerLeave(btn);
    expect(btn.getAttribute('data-armed')).toBeNull();

    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(run).toHaveBeenCalledOnce();
  });

  it('a non-destructive action still runs on one click', () => {
    const run = vi.fn();
    render(<ToolbarButton action={{ id: 'move', icon: <span>m</span>, label: 'Remove from folder', run }} />);
    fireEvent.click(screen.getByTestId('browseable-toolbar-move'));
    expect(run).toHaveBeenCalledOnce();
  });
});

describe('row layout', () => {
  it('puts the actions on the edge opposite the chevron, and never pads the chevron aside', async () => {
    vi.useRealTimers();
    const f = folder(nextId());
    const l = leaf(nextId(), f.id);
    h.bookmarks = [f, l];
    const { result } = renderHook(() => useFavoritesRoots());
    render(
      <TooltipProvider>
        <BrowseableTree roots={[{ ...result.current.roots[0], kind: 'root', ownsPointer: () => false, pathFor: () => Promise.resolve([]) }]} onNavigate={() => {}} mirrored />
      </TooltipProvider>,
    );

    const row = (await screen.findByTestId(`browseable-chevron-${f.id}`)).closest('[role="treeitem"]') as HTMLElement;
    const toolbar = screen.getByTestId(`browseable-row-toolbar-${f.id}`);
    // The row's last flex child — reversed with the row, so opposite the chevron.
    expect(row.lastElementChild).toBe(toolbar);
    expect(row.className).toContain('flex-row-reverse');
    expect(toolbar.contains(screen.getByTestId(`browseable-chevron-${f.id}`))).toBe(false);
    // No hover padding on the content side: that is what slid the chevron
    // into the trash button's spot.
    expect((row.firstElementChild as HTMLElement).className).not.toMatch(/pe-\[/);
    expect(screen.getByTestId('browseable-toolbar-delete-folder')).toBeTruthy();
  });
});

describe('folder counts', () => {
  it('the tooltip names both numbers the badge is drawn from', () => {
    const f = folder(nextId());
    h.bookmarks = [f, ...[0, 1, 2, 3, 4].map((i) => leaf(nextId(), f.id, i === 0))];
    const { result } = renderHook(() => useFavoritesRoots());
    const node = result.current.roots[0];
    const tooltip = render(<>{node.tooltip}</>);
    expect(tooltip.container.textContent).toContain('5 items');
    expect(tooltip.container.textContent).toContain('4 new');
    expect(render(<>{node.badge}</>).container.textContent).toBe('4');
  });
});
