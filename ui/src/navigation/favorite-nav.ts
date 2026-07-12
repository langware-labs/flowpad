import type { Bookmark } from '@sdk';
import type { SearchResult } from '@src/hooks/use-record-search';
import type { DockPointer } from './DockPointer';
import type { NavigationActions } from './NavigationActions';
import { isResultNavigable, navigateToResult, RECORD_TYPE_NAV } from './record-type-nav';

function asSearchResult(bookmark: Bookmark): SearchResult | null {
  const entityType = bookmark.data?.entity_type as string | undefined;
  const entityId = bookmark.data?.entity_id as string | undefined;
  if (!entityType || !entityId) return null;
  const nav = (bookmark.data?.nav ?? {}) as Record<string, unknown>;
  return {
    record_id: entityId,
    record_type: entityType,
    name: bookmark.title || entityId,
    text: '',
    status: 'open',
    scope: '',
    created_at: bookmark.created_date ? new Date(bookmark.created_date).toISOString() : '',
    modified_at: bookmark.updated_date ? new Date(bookmark.updated_date).toISOString() : '',
    asset_ref: (nav.asset_ref as string | undefined) ?? (nav.source_path as string | undefined) ?? '',
    session_id: nav.session_id as string | undefined,
  };
}

/**
 * Pure DockPointer for a favorite's target, when its record type navigates
 * via a `dockPointer` arm (URL-first). Returns null for `primaryAction`
 * types (session-likes needing async resolution) — callers fall back to the
 * imperative `navigateToFavorite`.
 */
export function pointerForFavorite(bookmark: Bookmark): DockPointer | null {
  const sr = asSearchResult(bookmark);
  if (!sr) return null;
  const nav = RECORD_TYPE_NAV[sr.record_type];
  if (!nav?.dockPointer) return null;
  return nav.dockPointer(sr) ?? null;
}

export function canNavigateFavorite(bookmark: Bookmark): boolean {
  const sr = asSearchResult(bookmark);
  return !!sr && isResultNavigable(sr);
}

/**
 * Navigate to the entity referenced by a favorite Bookmark. Reuses the
 * existing RECORD_TYPE_NAV dispatcher so any record_type wired up for
 * search navigation is automatically navigable as a favorite.
 */
export async function navigateToFavorite(
  bookmark: Bookmark,
  navigation: NavigationActions,
): Promise<void> {
  const sr = asSearchResult(bookmark);
  if (!sr) return;
  await navigateToResult(sr, navigation);
}
