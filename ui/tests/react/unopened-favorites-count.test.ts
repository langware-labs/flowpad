import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Bookmark, BookmarkType } from '@sdk';

const ACTIVE = 'c82a1115-2f20-52e0-aa2a-4658898b5873';
const OTHER = '24d99316-644a-41e4-bf6f-24065e6e1e81';

const h = vi.hoisted(() => ({ bookmarks: [] as Bookmark[], projectId: null as string | null }));

// The hook reads the live bookmark list and the active project. Stub both so we
// can drive a fixed set across projects.
vi.mock('@sdk/react/hooks', () => ({
  useEntitiesQuery: () => ({ data: h.bookmarks }),
  useProject: () => ({ project: h.projectId ? { id: h.projectId } : null }),
}));
vi.mock('@src/hooks/useContext', () => ({
  useContext: () => ({ project: h.projectId ? { id: h.projectId } : null }),
}));

const { useUnopenedFavoritesCount } = await import('@src/hooks/use-unopened-favorites-count');

let n = 0;
function favorite(opts: { project_id?: string | null; counter?: number }): Bookmark {
  n += 1;
  return new Bookmark({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    bookmark_type: BookmarkType.FAVORITE,
    title: `fav-${n}`,
    ...opts,
  });
}

afterEach(() => {
  h.bookmarks = [];
  h.projectId = null;
});

describe('useUnopenedFavoritesCount — the rail badge', () => {
  it('excludes favorites belonging to another project', () => {
    // The regression: the badge used to count every favorite, so it advertised
    // unread items the menu then filtered out — badge 3, menu 2.
    h.projectId = ACTIVE;
    h.bookmarks = [
      favorite({ project_id: null }), // personal — belongs everywhere
      favorite({ project_id: ACTIVE }),
      favorite({ project_id: OTHER }), // must NOT count
    ];

    const { result } = renderHook(() => useUnopenedFavoritesCount());

    expect(result.current).toBe(2);
  });

  it('counts unscoped favorites — they are personal, not another project&apos;s', () => {
    h.projectId = ACTIVE;
    h.bookmarks = [favorite({ project_id: null }), favorite({ project_id: null })];

    const { result } = renderHook(() => useUnopenedFavoritesCount());

    expect(result.current).toBe(2);
  });

  it('counts only never-opened favorites', () => {
    h.projectId = ACTIVE;
    h.bookmarks = [
      favorite({ project_id: ACTIVE, counter: 0 }),
      favorite({ project_id: ACTIVE, counter: 3 }), // opened — not unread
    ];

    const { result } = renderHook(() => useUnopenedFavoritesCount());

    expect(result.current).toBe(1);
  });

  it('with no active project, counts personal favorites and no project ones', () => {
    h.projectId = null; // user scope
    h.bookmarks = [favorite({ project_id: null }), favorite({ project_id: OTHER })];

    const { result } = renderHook(() => useUnopenedFavoritesCount());

    expect(result.current).toBe(1);
  });
});
