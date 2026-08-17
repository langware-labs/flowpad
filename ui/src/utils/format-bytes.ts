/**
 * One byte formatter.
 *
 * There were eight near-identical private copies of this in the tree when this
 * was written, only one of them exported (and that one buried in PTY viewer
 * internals). New call sites should import from here; the existing copies are
 * fair game to collapse into it as they are touched.
 */
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1);
  const value = bytes / Math.pow(1024, power);
  // Whole bytes never want a decimal point.
  return `${power === 0 ? value : value.toFixed(decimals)} ${UNITS[power]}`;
}
