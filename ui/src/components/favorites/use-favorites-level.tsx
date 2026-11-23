import { useFavoritesProjectRoots } from '@src/components/browseable-tree/adapters/useFavoritesRoots';
import type { Browseable, BrowseableRoot } from '@src/components/browseable-tree/types';
import { BreadcrumbChevron } from '@src/components/ui/breadcrumb';
import { useMemo, useState } from 'react';

export interface FavoritesCrumb {
  id: string;
  label: string;
}

export interface FavoritesLevel {
  /** The path below the project list: a project, then folders. Empty = the project list. */
  crumbs: FavoritesCrumb[];
  /** The rows of the level the path ends at. */
  rows: BrowseableRoot[];
  /** Where a new row at this level is filed, or null when the level cannot take one. */
  addParentId: string | null;
  /** Keep the first `depth` crumbs: 0 is the project list. */
  goTo: (depth: number) => void;
}

/**
 * The bookmarks panel shows ONE level of the favorites tree at a time, named by
 * a breadcrumb. This owns which level: it starts at the open project every time
 * it mounts (the panel unmounts when it closes), a project or folder row is
 * entered by click, and a crumb goes back up.
 *
 * The level is local state, like a tree's expansion — it is not navigation. It
 * is DERIVED from the live favorites on every render, never copied into state,
 * so a row added, renamed or removed shows at once.
 */
export function useFavoritesLevel(): FavoritesLevel {
  const { roots, currentBucketId, currentBucketLabel, rowsUnder, addParentFor } = useFavoritesProjectRoots();
  const [path, setPath] = useState<string[]>([currentBucketId]);

  return useMemo(() => {
    const crumbs: FavoritesCrumb[] = [];
    let nodes: Browseable[] = roots;
    for (const id of path) {
      const node = nodes.find((n) => n.id === id);
      if (!node) {
        // The open project holds nothing yet, so it is not a row — it is still
        // the level to land on, empty, where its first row is added.
        if (crumbs.length === 0 && id === currentBucketId) {
          crumbs.push({ id, label: currentBucketLabel });
          nodes = [];
        }
        // Anything else that is gone (a deleted folder) ends the path here.
        break;
      }
      crumbs.push({ id, label: node.label });
      nodes = rowsUnder(id);
    }
    const here = crumbs.map((c) => c.id);

    const rows = nodes.map((node): BrowseableRoot => {
      const row = { ...node, kind: 'root' as const, ownsPointer: () => false, pathFor: () => Promise.resolve([]) };
      if (node.hasChildren === false) return row;
      // A project or folder: a click enters it instead of expanding it in place.
      return {
        ...row,
        hasChildren: false,
        listChildren: undefined,
        pointer: null,
        activate: () => setPath([...here, node.id]),
        badge: (
          <span className="flex items-center gap-1">
            {node.badge}
            <BreadcrumbChevron className="h-3 w-3 text-muted-foreground" />
          </span>
        ),
      };
    });

    const levelId = here[here.length - 1] ?? '';
    return {
      crumbs,
      rows,
      // The project list owns no bookmarks.
      addParentId: levelId === '' ? null : addParentFor(levelId),
      goTo: (depth: number) => setPath(here.slice(0, depth)),
    };
  }, [roots, path, currentBucketId, currentBucketLabel, rowsUnder, addParentFor]);
}
