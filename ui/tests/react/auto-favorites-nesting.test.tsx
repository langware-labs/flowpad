import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Bookmark, BookmarkType } from '@sdk';

// useFavorites pulls the live bookmark list + the active project; stub both so we
// can drive a fixed nested tree and assert the client-side grouping.
const h = vi.hoisted(() => ({ bookmarks: [] as Bookmark[] }));

vi.mock('@src/hooks/use-project-bookmarks', () => ({
  useProjectBookmarks: () => ({ data: h.bookmarks, refetch: vi.fn(), excludeBookmarks: vi.fn() }),
}));
vi.mock('@sdk/react/hooks', () => ({
  useProject: () => ({ project: { id: 'p1' } }),
}));

const { useFavorites } = await import('@src/hooks/use-favorites');

// Stable v4-shaped ids (the Bookmark ctor validates `id` as a UUID).
const ID = {
  root: '00000000-0000-4000-8000-000000000001',
  skills: '00000000-0000-4000-8000-000000000002',
  docs: '00000000-0000-4000-8000-000000000003',
  s1: '00000000-0000-4000-8000-000000000011',
  s2: '00000000-0000-4000-8000-000000000012',
  m1: '00000000-0000-4000-8000-000000000021',
  loose: '00000000-0000-4000-8000-000000000031',
};

// Auto / Skills / (2 items), Auto / Documents / (1 item)
function nestedTree(): Bookmark[] {
  const root = new Bookmark({ id: ID.root, bookmark_type: BookmarkType.FAVORITE_FOLDER, title: 'Auto', data: { auto_root: true } });
  const skills = new Bookmark({ id: ID.skills, bookmark_type: BookmarkType.FAVORITE_FOLDER, title: 'Skills', parent_id: ID.root, data: { auto_type: 'skill' } });
  const docs = new Bookmark({ id: ID.docs, bookmark_type: BookmarkType.FAVORITE_FOLDER, title: 'Documents', parent_id: ID.root, data: { auto_type: 'markdown' } });
  const s1 = new Bookmark({ id: ID.s1, bookmark_type: BookmarkType.FAVORITE, title: 'dash', parent_id: ID.skills, source: 'auto', data: { entity_type: 'skill', entity_id: 's1' } });
  const s2 = new Bookmark({ id: ID.s2, bookmark_type: BookmarkType.FAVORITE, title: 'cleaner', parent_id: ID.skills, source: 'auto', data: { entity_type: 'skill', entity_id: 's2' } });
  const m1 = new Bookmark({ id: ID.m1, bookmark_type: BookmarkType.FAVORITE, title: 'notes', parent_id: ID.docs, source: 'auto', data: { entity_type: 'markdown', entity_id: 'm1' } });
  const loose = new Bookmark({ id: ID.loose, bookmark_type: BookmarkType.FAVORITE, title: 'manual', data: { entity_type: 'deck', entity_id: 'd1' } });
  return [root, skills, docs, s1, s2, m1, loose];
}

describe('useFavorites — nested auto tree', () => {
  it('rootFolders keeps only top-level folders; nested subfolders are hidden from root', () => {
    h.bookmarks = nestedTree();
    const { result } = renderHook(() => useFavorites());
    const rootIds = result.current.rootFolders.map((f) => f.id);
    expect(rootIds).toEqual([ID.root]); // Skills/Documents are NESTED, not at root
  });

  it('childrenOf returns BOTH nested subfolders and leaf favorites', () => {
    h.bookmarks = nestedTree();
    const { result } = renderHook(() => useFavorites());
    const underRoot = result.current.childrenOf(ID.root).map((b) => b.id).sort();
    expect(underRoot).toEqual([ID.skills, ID.docs].sort()); // the two subfolders
    const underSkills = result.current.childrenOf(ID.skills).map((b) => b.id).sort();
    expect(underSkills).toEqual([ID.s1, ID.s2].sort()); // the two leaves
  });

  it('a manual (non-nested) favorite still sits at root', () => {
    h.bookmarks = nestedTree();
    const { result } = renderHook(() => useFavorites());
    expect(result.current.rootFavorites.map((b) => b.id)).toContain(ID.loose);
  });
});
