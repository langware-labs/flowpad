import type { Bookmark } from '@sdk';
import { sdkConfig } from '@sdk/config/index';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

export interface FavoriteSummary {
  name: string | null;
  subtitle: string | null;
}

interface FavoriteRef {
  type: string;
  id: string;
}

interface SummaryResponse {
  summaries: Array<{
    type: string;
    id: string;
    name: string | null;
    subtitle: string | null;
  }>;
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

function refsKey(refs: FavoriteRef[]): string {
  return refs
    .map((r) => `${r.type}:${r.id}`)
    .sort()
    .join('|');
}

/**
 * Batch-fetches live tooltip summaries (name + subtitle) for the given
 * favorited entities. One POST per distinct ref-set; shared across all
 * FavoriteTile consumers via react-query.
 */
export function useFavoriteSummaries(bookmarks: Bookmark[]) {
  const refs = useMemo(() => refsFromBookmarks(bookmarks), [bookmarks]);
  const key = useMemo(() => refsKey(refs), [refs]);

  const { data } = useQuery({
    queryKey: ['favorite-summaries', key],
    queryFn: async () => {
      if (refs.length === 0) return { summaries: [] } as SummaryResponse;
      const resp = await fetch(`${sdkConfig.apiUrl}/api/v1/favorites/summary`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ refs }),
      });
      if (!resp.ok) throw new Error(`favorites/summary ${resp.status}`);
      return (await resp.json()) as SummaryResponse;
    },
    staleTime: 15_000,
  });

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
  return typeof type === 'string' && typeof id === 'string'
    ? summaries.get(favoriteSummaryKey(type, id))
    : undefined;
}
