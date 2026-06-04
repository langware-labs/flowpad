/**
 * Single source of truth for the "X ago" relative-time label used by the
 * indexer footer pill, the search "Index Recommended" banner, the scanner
 * page, and the favorites tooltips. Several places previously had their own
 * slightly-different bucketings; this collapses them.
 *
 * Returns null for null/undefined/empty/invalid input so the caller decides
 * what empty state to render (e.g. "never indexed" vs hiding the surface).
 * Items older than a week render as a localized `MMM d` date instead of
 * "365d ago".
 */
export function formatTimeAgo(iso: string | null | undefined): string | null {
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
