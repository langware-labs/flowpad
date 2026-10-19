import type { Bookmark } from '@sdk';
import { LazyAsset } from '@sdk/lazy';
import { useLazyAsset } from '@sdk/react/hooks/useLazyAsset';
import { useMemo } from 'react';

export interface FavoriteSummary {
  name: string | null;
  subtitle: string | null;
}

interface FavoriteRef {
  type: string;
  id: string;
}

function refsFromBookmarks(bookmarks: Bookmark[]): FavoriteRef[] {
  const out: FavoriteRef[] = [];
  for (const b of bookmarks) {
    const type = b.data?.entity_type;
    const id = b.data?.entity_id;
    if (typeof type === 'string' && typeof id === 'string') {
      out.push({ type, id });
    }
  }
  return out;
}

/**
 * Batch-fetches live tooltip summaries (name + subtitle) for the given
 * favorited entities. One POST per distinct ref-set; shared across all
 * desktop tile consumers via react-query.
 */
export function useFavoriteSummaries(bookmarks: Bookmark[]) {
  const refs = useMemo(() => refsFromBookmarks(bookmarks), [bookmarks]);
  const { data } = useLazyAsset(LazyAsset.FavoriteSummaries, { refs }, { priority: 'background' });

  return useMemo(() => {
    const map = new Map<string, FavoriteSummary>();
    for (const s of data?.summaries ?? []) {
      map.set(`${s.type}:${s.id}`, { name: s.name, subtitle: s.subtitle });
    }
    return map;
  }, [data]);
}

export function favoriteSummaryKey(entityType: string, entityId: string): string {
  return `${entityType}:${entityId}`;
}

/** Resolve a favorite bookmark's live summary from a batch-fetched map;
 *  undefined for bookmarks without a string entity ref (e.g. folders). */
export function summaryForBookmark(
  bookmark: Bookmark,
  summaries: Map<string, FavoriteSummary>,
): FavoriteSummary | undefined {
  const type = bookmark.data?.entity_type;
  const id = bookmark.data?.entity_id;
  return typeof type === 'string' && typeof id === 'string' ? summaries.get(favoriteSummaryKey(type, id)) : undefined;
}
