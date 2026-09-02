import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AUTO_BOOKMARK_SOURCE, Bookmark, BookmarkType } from '@sdk';

/**
 * The auto-bookmark tree must show exactly ONE "Auto" root per project. On a
 * pre-existing install it shows TWO: `mint_auto_favorite` keys its
 * find-or-create on `project_id` (scope_filter in flow_sdk/builtin/bookmark.py),
 * so it never sees an Auto root written before project stamping existed and
 * mints a fresh one — while `bookmarkInScope` renders an UNSCOPED bookmark in
 * EVERY scope. Writer and reader disagree, so both roots land at the top level
 * of the favorites desktop side by side.
 *
 * Real row shape, from the `oss` instance (2026-09-02):
 *   cdb52db1… "Auto" project_id NULL      (2026-07-15, pre-stamping)
 *   4b8090de… "Auto" project_id ec073acc… (2026-08-24)
 */
const h = vi.hoisted(() => ({
  bookmarks: [] as Bookmark[],
  project: 'ec073acc-f7bb-4292-a2b4-b5fcb5c34659',
}));

vi.mock('@src/hooks/use-project-bookmarks', () => ({
  useProjectBookmarks: () => ({ data: h.bookmarks, refetch: vi.fn(), excludeBookmarks: vi.fn() }),
}));
vi.mock('@sdk/react/hooks', () => ({ useProject: () => ({ project: { id: h.project } }) }));
vi.mock('@src/hooks/use-favorite-summaries', () => ({
  useFavoriteSummaries: () => ({}),
  summaryForBookmark: () => undefined,
}));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useCurrentDock: () => null,
  useDockNavigation: () => ({ navigation: { openDock: vi.fn() }, currentDock: null }),
}));

const PROJECT = h.project;

const ID = {
  legacyRoot: '00000000-0000-4000-8000-000000000001',
  legacyFiles: '00000000-0000-4000-8000-000000000002',
  projectRoot: '00000000-0000-4000-8000-000000000011',
  projectFiles: '00000000-0000-4000-8000-000000000012',
};

const { useFavoritesRoots } = await import('@src/components/browseable-tree/adapters/useFavoritesRoots');
const { bookmarkInScope } = await import('@src/lib/bookmark-scope');
const { projectScope } = await import('@src/lib/scope-filter');

/** The unscoped legacy Auto tree plus the one this project minted for itself. */
function twoAutoTrees(): Bookmark[] {
  return [
    // Written before `project_id` stamping — no project_id at all.
    new Bookmark({
      id: ID.legacyRoot,
      bookmark_type: BookmarkType.FAVORITE_FOLDER,
      title: 'Auto',
      source: AUTO_BOOKMARK_SOURCE,
      data: { auto_root: true },
    }),
    new Bookmark({
      id: ID.legacyFiles,
      bookmark_type: BookmarkType.FAVORITE_FOLDER,
      title: 'Files',
      source: AUTO_BOOKMARK_SOURCE,
      parent_id: ID.legacyRoot,
      data: { auto_type: 'file' },
    }),
    // Minted later by a `flow show` inside PROJECT, because the scoped scan
    // could not see the row above.
    new Bookmark({
      id: ID.projectRoot,
      bookmark_type: BookmarkType.FAVORITE_FOLDER,
      title: 'Auto',
      source: AUTO_BOOKMARK_SOURCE,
      project_id: PROJECT,
      data: { auto_root: true },
    }),
    new Bookmark({
      id: ID.projectFiles,
      bookmark_type: BookmarkType.FAVORITE_FOLDER,
      title: 'Files',
      source: AUTO_BOOKMARK_SOURCE,
      parent_id: ID.projectRoot,
      project_id: PROJECT,
      data: { auto_type: 'file' },
    }),
  ];
}

/** Exactly what `useFavoritesScope` hands the adapter while PROJECT is active
 *  (`useDefaultScopeFilter` picks project scope whenever a project is open). */
const scopeFilter = (b: Bookmark): boolean => bookmarkInScope(b, projectScope(PROJECT), PROJECT);

describe('auto-bookmark tree — one Auto root per project', () => {
  it('renders a single "Auto" folder at the favorites root', () => {
    h.bookmarks = twoAutoTrees();
    const { result } = renderHook(() => useFavoritesRoots({ filter: scopeFilter }));
    const autoRoots = result.current.roots.filter((n) => n.label === 'Auto');
    expect(autoRoots.map((n) => n.id)).toEqual([ID.projectRoot]);
  });
});
