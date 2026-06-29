import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrowseableTree } from '@src/components/browseable-tree/BrowseableTree';
import { useBrowseableTree } from '@src/components/browseable-tree/useBrowseableTree';
import type { Browseable, BrowseableRoot } from '@src/components/browseable-tree/types';

const KEY = 'test.browseableTree.expanded';

function makeRoot(children: Browseable[] = []): BrowseableRoot {
  return {
    id: 'group-root:test',
    kind: 'root',
    label: 'Test Root',
    hasChildren: 'unknown',
    pointer: null,
    listChildren: () => Promise.resolve(children),
    ownsPointer: () => false,
    pathFor: () => Promise.resolve([]),
  };
}

describe('useBrowseableTree persistence', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => cleanup());

  it('defaults to ephemeral empty expansion when no options are given (back-compat)', () => {
    const { result } = renderHook(() => useBrowseableTree([makeRoot()]));
    expect(result.current.isExpanded('group-root:test')).toBe(false);
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('applies defaultExpandedIds when no persisted state exists', () => {
    const { result } = renderHook(() =>
      useBrowseableTree([makeRoot()], { persistKey: KEY, defaultExpandedIds: ['group-root:test'] }),
    );
    expect(result.current.isExpanded('group-root:test')).toBe(true);
  });

  it('persisted state overrides the default', () => {
    window.localStorage.setItem(KEY, JSON.stringify(['some-folder']));
    const { result } = renderHook(() =>
      useBrowseableTree([makeRoot()], { persistKey: KEY, defaultExpandedIds: ['group-root:test'] }),
    );
    expect(result.current.isExpanded('group-root:test')).toBe(false);
    expect(result.current.isExpanded('some-folder')).toBe(true);
  });

  it('writes expansion changes back to localStorage', async () => {
    const root = makeRoot();
    const { result } = renderHook(() => useBrowseableTree([root], { persistKey: KEY }));
    await act(async () => {
      await result.current.expand(root);
    });
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toContain('group-root:test');
    act(() => {
      result.current.collapse(root.id);
    });
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).not.toContain('group-root:test');
  });

  it('survives junk in localStorage (falls back to defaults)', () => {
    window.localStorage.setItem(KEY, '{not json[');
    const { result } = renderHook(() =>
      useBrowseableTree([makeRoot()], { persistKey: KEY, defaultExpandedIds: ['group-root:test'] }),
    );
    expect(result.current.isExpanded('group-root:test')).toBe(true);
  });
});

describe('BrowseableTree restored expansion', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => cleanup());

  it('loads children for default-expanded nodes (first layer open, even when empty)', async () => {
    const root = makeRoot([]); // empty library
    render(<BrowseableTree roots={[root]} activePointer={null} persistKey={KEY} defaultExpandedIds={[root.id]} />);
    // The restored-expansion self-heal must fetch children and render the
    // expanded-but-empty state ("Empty"), not an inert collapsed row.
    await waitFor(() => expect(screen.getByText('Empty')).toBeTruthy());
    const row = document.querySelector('[data-browseable-id="group-root:test"] [role="treeitem"]');
    expect(row?.getAttribute('aria-expanded')).toBe('true');
  });

  it('renders restored children for persisted expansion', async () => {
    window.localStorage.setItem(KEY, JSON.stringify(['group-root:test']));
    const leaf: Browseable = {
      id: 'leaf-1',
      kind: 'asset',
      label: 'My Prompt',
      hasChildren: false,
      pointer: null,
    };
    render(<BrowseableTree roots={[makeRoot([leaf])]} activePointer={null} persistKey={KEY} />);
    await waitFor(() => expect(screen.getByText('My Prompt')).toBeTruthy());
  });
});
