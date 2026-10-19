import type { Bookmark } from '@sdk';
import { formatTimeAgo as canonicalTimeAgo } from '@src/utils/format-time-ago';

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

/**
 * Re-export of the canonical formatter with this module's empty-string
 * convention (its callers drop the result straight into JSX).
 */
export function formatTimeAgo(value?: string | Date | null): string {
  return canonicalTimeAgo(value) ?? '';
}

// ---------------------------------------------------------------------------
// Bookmark filter types + helpers
// ---------------------------------------------------------------------------

export enum BookmarkFilter {
  Open = 'open',
  Pending = 'pending',
  Closed = 'closed',
  All = 'all',
}

export function isBookmarkRemindPast(bookmark: Bookmark): boolean {
  if (!bookmark.remind_at) return true;
  return new Date(bookmark.remind_at).getTime() <= Date.now();
}

export function filterBookmark(bookmark: Bookmark, filter: BookmarkFilter): boolean {
  switch (filter) {
    case BookmarkFilter.Open:
      if (bookmark.status === 'closed') return false;
      if (bookmark.status === 'pending' && !isBookmarkRemindPast(bookmark)) return false;
      return true;
    case BookmarkFilter.Pending:
      return bookmark.status === 'pending' && !isBookmarkRemindPast(bookmark);
    case BookmarkFilter.Closed:
      return bookmark.status === 'closed';
    case BookmarkFilter.All:
      return true;
  }
}
