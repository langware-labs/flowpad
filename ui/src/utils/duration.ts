/**
 * Human durations, in both directions.
 *
 * `formatTimeAgo` (ui/src/utils/format-time-ago.ts) collapses everything under
 * a minute to "just now" and switches to an absolute date past a week — right
 * for feeds, wrong for "is this poller stale?" and "when does it next run?",
 * where seconds are the whole point. These keep second granularity and read
 * forwards or backwards from the same ladder.
 */
const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Seconds → the coarsest useful unit: `45s`, `3m 20s`, `2h 5m`, `4d`. */
export function humanizeSeconds(total: number): string {
  const s = Math.max(0, Math.round(total));
  if (s < MINUTE) return `${s}s`;
  if (s < HOUR) {
    const rest = s % MINUTE;
    return rest ? `${Math.floor(s / MINUTE)}m ${rest}s` : `${Math.floor(s / MINUTE)}m`;
  }
  if (s < DAY) {
    const rest = Math.floor((s % HOUR) / MINUTE);
    return rest ? `${Math.floor(s / HOUR)}h ${rest}m` : `${Math.floor(s / HOUR)}h`;
  }
  return `${Math.floor(s / DAY)}d`;
}

/** How long ago an ISO timestamp was. `fallback` covers null/unparseable. */
export function timeSince(iso: string | null | undefined, fallback = 'never'): string {
  const ms = isoToMs(iso);
  if (ms === null) return fallback;
  return `${humanizeSeconds((Date.now() - ms) / 1000)} ago`;
}

/** How long until an ISO timestamp. Past-due reads as `due now`, not negative. */
export function timeUntil(iso: string | null | undefined, whenDue = 'due now'): string {
  const ms = isoToMs(iso);
  if (ms === null) return whenDue;
  const delta = ms - Date.now();
  return delta <= 0 ? whenDue : `in ${humanizeSeconds(delta / 1000)}`;
}

function isoToMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}
