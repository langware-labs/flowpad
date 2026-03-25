// PtySegment.ts — time-partitioned segment for bucketing trace events to terminal rows.

export interface PtyRowRange {
  absRow: number;      // absolute buffer row
  startTime: number;   // ms epoch
  endTime: number;     // ms epoch
}

/** Prompt boundary anchor — resolved from Annotation with labels: ['prompt:']. */
export interface PtyAnchor {
  text: string;      // Prompt content — used to locate the row in xterm buffer
  time: string;      // ISO timestamp from the annotation
  absRow?: number;   // Resolved after scanning xterm
}

/** One absolute row mapped to a [startTime, stopTime] ISO range. */
export interface PtyLineRange {
  absRow: number;
  startTime: string;  // ISO
  stopTime: string;   // ISO
}

/**
 * A time-partitioned segment that maps timestamps to absolute terminal rows.
 *
 * Phase 1: a single segment spans the entire session. Future phases will add
 * multiple segments anchored to user prompts.
 *
 * Row distribution: D rows are distributed uniformly over [startTime, endTime].
 * Row i covers [startTime + i*duration/D, startTime + (i+1)*duration/D].
 * endTime is refreshed from Date.now() at most once every 5 seconds so the
 * segment stays open-ended without thrashing row-range calculations on every chunk.
 */
export class PtySegment {
  startTime: number;   // ms epoch — fixed at segment creation
  endTime: number;     // ms epoch — refreshed at most every 5 s during live sessions (unless finalized)
  rows: number;        // D = max(3, xterm.rows - 4)
  baseAbsRow: number;  // abs_row of row 0 in this segment (evictionOffset at creation)
  startAnchor: PtyAnchor | null = null;  // Phase-2: prompt anchor at segment start
  endAnchor: PtyAnchor | null = null;    // Phase-2: prompt anchor at segment end
  /** When true, endTime is fixed and bucketTimestamp will not overwrite it with Date.now(). */
  finalized = false;
  /** Last time endTime was refreshed from Date.now() — throttled to once per 5 s. */
  private _lastEndTimeRefresh = 0;

  constructor(startTime: number, rows: number, baseAbsRow: number) {
    this.startTime = startTime;
    this.rows = rows;
    this.baseAbsRow = baseAbsRow;
    this.endTime = Date.now();
    this._lastEndTimeRefresh = this.endTime;
  }

  /** Uniform time slots for each row in this segment (snapshot at current endTime). */
  get rowRanges(): PtyRowRange[] {
    const d = this.rows;
    const duration = Math.max(1, this.endTime - this.startTime);
    const ranges: PtyRowRange[] = [];
    for (let i = 0; i < d; i++) {
      ranges.push({
        absRow: this.baseAbsRow + i,
        startTime: this.startTime + (i * duration) / d,
        endTime: this.startTime + ((i + 1) * duration) / d,
      });
    }
    return ranges;
  }

  /**
   * Returns the absRow for a given timestamp.
   * For open-ended (non-finalized) segments, refreshes endTime from Date.now() at most
   * once every 5 seconds to avoid thrashing row-range calculations on every chunk.
   * For finalized segments, uses the stored endTime as-is.
   * Clamps to [baseAbsRow, baseAbsRow + D - 1].
   */
  bucketTimestamp(ts: number): number {
    if (!this.finalized) {
      const now = Date.now();
      if (now - this._lastEndTimeRefresh >= 5_000) {
        this.endTime = now;
        this._lastEndTimeRefresh = now;
      }
    }
    const duration = Math.max(1, this.endTime - this.startTime);
    const d = this.rows;
    let rowIndex = Math.floor(((ts - this.startTime) / duration) * d);
    rowIndex = Math.max(0, Math.min(d - 1, rowIndex));
    return this.baseAbsRow + rowIndex;
  }
}

/**
 * Top-level helper: bucket a timestamp into an absRow using an ordered list of
 * segments.
 *
 * Finds the first segment whose [startTime, endTime] contains `ts`.
 * Falls back to the last segment when no segment contains the timestamp
 * (e.g. the session is still live and the last segment is open-ended).
 */
export function bucketEventToAbsRow(ts: number, segments: PtySegment[]): number {
  if (segments.length === 0) return 0;
  for (const seg of segments) {
    if (ts >= seg.startTime && ts <= seg.endTime) {
      return seg.bucketTimestamp(ts);
    }
  }
  // ts is outside all known segment ranges — use the last segment as fallback.
  return segments[segments.length - 1].bucketTimestamp(ts);
}
