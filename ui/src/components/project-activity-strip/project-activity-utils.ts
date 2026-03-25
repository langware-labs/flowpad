import type { Bookmark } from '@sdk';

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

export function formatTimeAgo(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const diffMs = Date.now() - date.getTime();
  const diffMinutes = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMinutes < 1) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
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
