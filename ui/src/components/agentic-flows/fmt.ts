/** Tiny time formatters shared by status lines, journal, and chain view. */

export function fmtElapsed(fromMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtRelative(tsMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - tsMs) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
}

export function parseIsoMs(ts: string): number {
  const v = Date.parse(ts);
  return Number.isNaN(v) ? Date.now() : v;
}

// ── node status line (shared by the canvas card and the node inspector) ──────

interface LiveLike {
  queued: number;
  active: number;
  startedAt?: number;
  error?: string;
  lastDurationMs?: number;
  lastFinishedAt?: number;
}

/** One-line live status for a node — the "running > failed > queued >
 * last-run > idle" ladder, in one place so surfaces can't drift. */
export function nodeStatusLine(
  live: LiveLike | undefined,
  workerStatus: string | undefined,
  now: number,
): { text: string; color: string } {
  if ((live?.active ?? 0) > 0) {
    const worker = workerStatus ? workerStatus.replace(/_/g, ' ') : 'running';
    const elapsed = live?.startedAt ? ` · ${fmtElapsed(live.startedAt, now)}` : '';
    return { text: `▶ ${worker}${elapsed}`, color: '#2ea043' };
  }
  if (live?.error) return { text: `✗ ${live.error}`, color: '#ff6b63' };
  if ((live?.queued ?? 0) > 0) return { text: `⏳ ${live?.queued} queued`, color: '#d3b136' };
  if (live?.lastFinishedAt) {
    const dur = live.lastDurationMs ? `${fmtDuration(live.lastDurationMs)} · ` : '';
    return { text: `✓ ${dur}${fmtRelative(live.lastFinishedAt, now)}`, color: '#8a93ab' };
  }
  return { text: 'idle', color: '#4a5065' };
}
