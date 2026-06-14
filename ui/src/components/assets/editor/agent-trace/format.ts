/** Compact duration formatter for the call-stack / detail rows: "5s", "3m",
 * "2h05". Distinct from lens-viewer `formatDuration` ("3m 12s") — these rows
 * need the terse single/double-unit form. */
export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
}
