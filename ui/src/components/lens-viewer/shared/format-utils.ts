/** Formatters reused across all transcript viewers — pure, no entry-shape coupling. */

export function formatNumber(num: number): string {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return num.toLocaleString();
}

export function formatAgo(isoTs: string): string {
  const diffMs = Date.now() - new Date(isoTs).getTime();
  if (diffMs < 60_000) return 'just now';
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}

/** Format an ISO timestamp as local time-of-day. Returns "--:--" for invalid input. */
export function formatTime(isoTs: string | null | undefined): string {
  if (!isoTs) return '--:--';
  const date = new Date(isoTs);
  return Number.isNaN(date.getTime()) ? '--:--' : date.toLocaleTimeString();
}
