import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Bookmark, BookmarkType } from '@sdk';

const FOLDER = '00000000-0000-4000-8000-000000000001';
const LEAF = '00000000-0000-4000-8000-000000000011';
const ROOT_LEAF = '00000000-0000-4000-8000-000000000021';
// Real (resolvable) entity ids so each leaf clears the ghost-reap navigability
// gate (`canNavigateFavorite`) and actually renders — a favorite whose target
// resolves nowhere is now hidden before its toolbar is reachable. Must be valid
// entity ids (UUID v4/v5) or `resultTypeId` rejects them and the pointer is null.
const LEAF_ENTITY = '00000000-0000-4000-8000-0000000000aa';
const ROOT_LEAF_ENTITY = '00000000-0000-4000-8000-0000000000bb';

const h = vi.hoisted(() => ({ bookmarks: [] as Bookmark[], refreshNode: vi.fn(), refetch: vi.fn() }));

vi.mock('@src/hooks/use-project-bookmarks', () => ({
  useProjectBookmarks: () => ({ data: h.bookmarks, refetch: h.refetch, excludeBookmarks: vi.fn() }),
}));
vi.mock('@sdk/react/hooks', () => ({ useProject: () => ({ project: { id: 'p1' } }) }));
// The mechanism under test: the tree caches an expanded folder's children, so a
// mutation must tell it to reload that folder.
vi.mock('@src/components/browseable-tree/refresh-store', () => ({ refreshNode: h.refreshNode }));
vi.mock('@src/hooks/use-favorite-summaries', () => ({
  useFavoriteSummaries: () => ({}),
  summaryForBookmark: () => undefined,
}));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useCurrentDock: () => null,
  useDockNavigation: () => ({ navigation: { openDock: vi.fn() }, currentDock: null }),
}));

const { useFavoritesRoots } = await import('@src/components/browseable-tree/adapters/useFavoritesRoots');

const folder = new Bookmark({ id: FOLDER, bookmark_type: BookmarkType.FAVORITE_FOLDER, title: 'Repo' });
const leafInFolder = new Bookmark({
  id: LEAF,
  bookmark_type: BookmarkType.FAVORITE,
  title: 'git-basics',
  parent_id: FOLDER,
  data: { entity_type: 'markdown', entity_id: LEAF_ENTITY },
});
const rootLeaf = new Bookmark({
  id: ROOT_LEAF,
  bookmark_type: BookmarkType.FAVORITE,
  title: 'loose',
  data: { entity_type: 'markdown', entity_id: ROOT_LEAF_ENTITY },
});
for (const b of [folder, leafInFolder, rootLeaf]) b.delete = vi.fn(() => Promise.resolve());

/** Pull a leaf's remove-favorite toolbar action out of the adapter's roots. */
async function removeActionFor(id: string) {
  const { result } = renderHook(() => useFavoritesRoots());
  type Node = { id: string; toolbar?: { id: string; run: () => unknown }[]; listChildren?: () => Promise<Node[]> };
  const findLeaf = async (nodes: Node[]): Promise<Node | null> => {
    for (const n of nodes) {
      if (n.id === id) return n;
      if (n.listChildren) {
        const hit = await findLeaf(await n.listChildren());
        if (hit) return hit;
      }
    }
    return null;
  };
  const leaf = await findLeaf(result.current.roots as unknown as Node[]);
  return leaf?.toolbar?.find((a) => a.id === 'remove-favorite');
}

afterEach(() => vi.clearAllMocks());

describe('favorites remove → tree refresh', () => {
  it('refreshes the parent folder after removing a favorite inside it', async () => {
    h.bookmarks = [folder, leafInFolder];
    const action = await removeActionFor(LEAF);
    await action.run();
    // The bug: without this the row lingered because the tree kept its cached
    // children. Refreshing FOLDER makes the tree reload and drop the row.
    expect(h.refreshNode).toHaveBeenCalledWith(FOLDER);
  });

  it('does NOT refresh for a root-level favorite (the roots prop updates it)', async () => {
    h.bookmarks = [rootLeaf];
    const action = await removeActionFor(ROOT_LEAF);
    await action.run();
    expect(h.refreshNode).not.toHaveBeenCalled();
  });
});
