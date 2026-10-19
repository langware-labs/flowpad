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

/** What a status line MEANS — the color for each tone lives in
 * graph-workflows.css (`.stl-<tone>`), so the formatter stays theme-blind.
 * It used to hand back hex literals, and a fixed hex can only be legible
 * against one background: the old `#4a5065` idle grey read at ~2.5:1 on the
 * dark canvas, the `#8a93ab` done-grey at ~2.7:1 on the light one. */
export type StatusTone = 'running' | 'failed' | 'queued' | 'done' | 'idle';

/** One-line live status for a node — the "running > failed > queued >
 * last-run > idle" ladder, in one place so surfaces can't drift. */
export function nodeStatusLine(
  live: LiveLike | undefined,
  workerStatus: string | undefined,
  now: number,
): { text: string; tone: StatusTone } {
  if ((live?.active ?? 0) > 0) {
    const worker = workerStatus ? workerStatus.replace(/_/g, ' ') : 'running';
    const elapsed = live?.startedAt ? ` · ${fmtElapsed(live.startedAt, now)}` : '';
    return { text: `▶ ${worker}${elapsed}`, tone: 'running' };
  }
  if (live?.error) return { text: `✗ ${live.error}`, tone: 'failed' };
  if ((live?.queued ?? 0) > 0) return { text: `⏳ ${live?.queued} queued`, tone: 'queued' };
  if (live?.lastFinishedAt) {
    const dur = live.lastDurationMs ? `${fmtDuration(live.lastDurationMs)} · ` : '';
    return { text: `✓ ${dur}${fmtRelative(live.lastFinishedAt, now)}`, tone: 'done' };
  }
  return { text: 'idle', tone: 'idle' };
}

/** Coerce an unknown (node_data / journal) value to a display string —
 * strings pass through, everything else renders as JSON, never "[object Object]". */
export function asStr(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}
