/**
 * Single source of truth for the "X ago" relative-time label used by the
 * indexer footer pill, the search "Index Recommended" banner, the scanner
 * page, and the favorites tooltips. Several places previously had their own
 * slightly-different bucketings; this collapses them.
 *
 * Accepts an ISO string or a `Date` (entity date fields arrive as `Date`).
 * Returns null for null/undefined/empty/invalid input so the caller decides
 * what empty state to render (e.g. "never indexed" vs hiding the surface).
 * Items older than a week render as a localized `MMM d` date instead of
 * "365d ago".
 */
export function formatTimeAgo(iso: string | Date | null | undefined): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const ms = Date.now() - t;
  if (ms < 0) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Terse sibling of `formatTimeAgo` for dense chrome — tab tooltips, spotlight
 * rows, worker-history lists. Differences: seconds are shown (`12s ago`), old
 * items keep counting in days rather than switching to a date, and an
 * absent/unparseable value renders the em dash itself so callers can drop it
 * straight into JSX.
 */
export function formatTimeAgoShort(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
