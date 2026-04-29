import type { Terminal } from '@xterm/xterm';
import type { OutputChunk } from './types.js';
import { LiveXtermAdapter } from './adapter/XtermAdapter.js';
import { VirtualTerminal } from './simulator/VirtualTerminal.js';
import { PtySegment, bucketEventToAbsRow } from './PtySegment.js';
import type { PtyAnchor, PtyLineRange } from './PtySegment.js';

// ── Snapshot (immutable between bumps) ─────────────────────────────────────

export interface PtySyncSnapshot {
  adapter: LiveXtermAdapter | null;
  vt: VirtualTerminal | null;
  version: number;
  refLines: PtyLineRange[];
}

// ── Config ─────────────────────────────────────────────────────────────────

export interface PtySyncConfig {
  scrollbackLines?: number;  // default: 10000
  seed?: number;             // default: 0
}

// ── Session class ──────────────────────────────────────────────────────────

type Listener = () => void;

export class PtySyncSession {
  private _adapter: LiveXtermAdapter | null = null;
  private _vt: VirtualTerminal | null = null;
  private _version = 0;
  private _snapshot: PtySyncSnapshot;
  private _listeners = new Set<Listener>();
  private readonly _scrollbackLines: number;
  private readonly _seed: number;
  private _segments: PtySegment[] = [];
  private _notifyScheduled = false;

  constructor(config?: PtySyncConfig) {
    this._scrollbackLines = config?.scrollbackLines ?? 10000;
    this._seed = config?.seed ?? 0;
    this._snapshot = this._buildSnapshot();
  }

  // ── Segments ───────────────────────────────────────────────────────────

  /**
   * Create the Phase-1 single segment covering the full session.
   * Call after initialize() once sessionStartTime is known.
   *
   * @param sessionStartTime  ms epoch — from ShellRecord.created_at
   * @param rows              D = max(3, xterm.rows - 4)
   * @param baseAbsRow        evictionOffset at segment creation time
   */
  initSegments(sessionStartTime: number, rows: number, baseAbsRow: number): void {
    // Don't overwrite anchor-based segments — they are more precise.
    if (this._segments.some(s => s.startAnchor !== null)) return;
    this._segments = [new PtySegment(sessionStartTime, rows, baseAbsRow)];
    this._bump();
  }

  /**
   * Rebuild segments anchored to actual prompt boundaries.
   * Each anchor is an Annotation with labels: ['prompt:'].
   * Scans the xterm buffer to find where each anchor's text appears.
   */
  buildSegmentsFromAnchors(anchors: PtyAnchor[]): void {
    if (!this._adapter) return;

    const sorted = [...anchors].sort((a, b) => a.time.localeCompare(b.time));

    // Resolve absRow for each anchor by scanning the remaining buffer.
    // Each anchor's search starts after the previous match to avoid
    // duplicate hits when multiple prompts have identical text.
    const bufLen = this._adapter.getBufferLength();
    const eviction = this._adapter.getEvictionOffset();
    let scanFrom = eviction;
    for (const anchor of sorted) {
      const needle = anchor.text.slice(0, 60);
      // Try with prompt prefix first (live session), fall back to raw text (replay).
      const candidates = ['❯ ' + needle, needle];
      for (let absRow = scanFrom; absRow < eviction + bufLen; absRow++) {
        const lineText = this._adapter.getLineText(absRow);
        if (lineText && candidates.some(c => lineText.trimStart().startsWith(c))) {
          anchor.absRow = absRow;
          scanFrom = absRow + 1;
          break;
        }
      }
    }

    const resolved = sorted.filter(a => a.absRow !== undefined);
    if (resolved.length === 0) {
      return;
    }

    const newSegments: PtySegment[] = [];
    for (let i = 0; i < resolved.length; i++) {
      const startAnchor = resolved[i];
      const endAnchor = resolved[i + 1] ?? null;

      const baseAbsRow = startAnchor.absRow!;
      const endAbsRow = endAnchor?.absRow ?? (eviction + bufLen);
      const rows = Math.max(1, endAbsRow - baseAbsRow);
      const startTime = new Date(startAnchor.time).getTime();
      const endTime = endAnchor ? new Date(endAnchor.time).getTime() : Date.now();

      const seg = new PtySegment(startTime, rows, baseAbsRow);
      seg.endTime = endTime;
      seg.finalized = endAnchor !== null;  // finalize all but the last (open-ended) segment
      seg.startAnchor = startAnchor;
      seg.endAnchor = endAnchor;
      newSegments.push(seg);
    }

    this._segments = newSegments;
    this._bump();
  }

  /**
   * Set the end time of the single default (Phase-1) segment.
   * Used when no annotations are present: anchors the segment's end to
   * the last transcript event timestamp instead of Date.now().
   */
  finalizeDefaultSegment(endTimeMs: number): void {
    if (this._segments.length === 1) {
      this._segments[0].endTime = endTimeMs;
      this._segments[0].finalized = true;
      this._bump();
    }
  }

  /** Flatten all segment rowRanges into a PtyLineRange[] (one per absRow). */
  getRefLines(): PtyLineRange[] {
    const result: PtyLineRange[] = [];
    for (const seg of this._segments) {
      for (const range of seg.rowRanges) {
        result.push({
          absRow: range.absRow,
          startTime: new Date(range.startTime).toISOString(),
          stopTime: new Date(range.endTime).toISOString(),
        });
      }
    }
    return result;
  }

  /** True if any segment was built from a resolved prompt anchor. */
  hasAnchorSegments(): boolean {
    return this._segments.some(s => s.startAnchor !== null);
  }

  /**
   * Map a ms-epoch timestamp to an absolute buffer row.
   * Returns 0 if no segments have been initialized yet.
   */
  bucketTimestamp(ts: number): number {
    return bucketEventToAbsRow(ts, this._segments);
  }

  /**
   * Returns the set of absRow values that are the first row of a new PTY segment
   * (i.e., segment boundaries, excluding the very first segment's start row).
   */
  getSegmentBorderRows(): { starts: Set<number>; ends: Set<number> } {
    const starts = new Set<number>();
    const ends = new Set<number>();
    for (const seg of this._segments) {
      starts.add(seg.baseAbsRow);
      ends.add(seg.baseAbsRow + seg.rows - 1);
    }
    return { starts, ends };
  }

  /** Returns the segment whose start or end row matches absRow, plus which boundary it is. */
  getSegmentForBorderRow(absRow: number): { isStart: boolean; isEnd: boolean; segment: PtySegment } | null {
    for (const seg of this._segments) {
      const isStart = seg.baseAbsRow === absRow;
      const isEnd = seg.baseAbsRow + seg.rows - 1 === absRow;
      if (isStart || isEnd) return { isStart, isEnd, segment: seg };
    }
    return null;
  }

  /**
   * Returns the time range [startTime, endTime] (ms epoch) assigned to an
   * absolute row by the current segment. Returns null if no segment initialized.
   */
  getRowTimeRange(absRow: number): { startTime: number; endTime: number } | null {
    if (this._segments.length === 0) return null;
    const seg = this._segments[this._segments.length - 1];
    if (!seg.finalized) seg.endTime = Date.now(); // keep open-ended for live segments
    const ranges = seg.rowRanges;
    return ranges.find((r) => r.absRow === absRow) ?? null;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /** Called once after xterm.open() + FitAddon.fit() completes. */
  initialize(term: Terminal): void {
    const adapter = new LiveXtermAdapter(term);
    this._adapter = adapter;

    const dims = adapter.getDimensions();
    this._vt = new VirtualTerminal({
      cols: dims.cols,
      rows: dims.rows,
      cellWidth: dims.cellWidth,
      cellHeight: dims.cellHeight,
      scrollbackLines: this._scrollbackLines,
      seed: this._seed,
    });

    this._bump();
  }

  /** Tear down adapter and VT. Called on terminal dispose. */
  dispose(): void {
    this._adapter = null;
    this._vt = null;
    this._bump();
  }

  // ── Chunk processing ──────────────────────────────────────────────────

  /**
   * Feed a PTY chunk through VT and keep adapter eviction offset in sync.
   */
  processChunk(chunk: OutputChunk): void {
    const vt = this._vt;
    if (!vt) return;

    vt.processChunk(chunk);

    // Keep eviction offset in sync on every chunk (not just rebuild)
    if (this._adapter) {
      this._adapter.setEvictionOffset(vt.getTotalScrolledOff());
    }

    this._bump();
  }

  // ── Resize ────────────────────────────────────────────────────────────

  /**
   * Rebuild VT with new dimensions and replay all chunks.
   * Called from ResizeObserver handler.
   */
  rebuild(chunks: OutputChunk[]): void {
    if (!this._adapter) return;

    const dims = this._adapter.getDimensions();
    const newVt = new VirtualTerminal({
      cols: dims.cols,
      rows: dims.rows,
      cellWidth: dims.cellWidth,
      cellHeight: dims.cellHeight,
      scrollbackLines: this._scrollbackLines,
      seed: this._seed,
    });

    for (const chunk of chunks) {
      newVt.processChunk(chunk);
    }

    this._adapter.setEvictionOffset(newVt.getTotalScrolledOff());
    this._vt = newVt;
    this._bump();
  }

  /** Bump snapshot version after xterm has flushed its write queue. */
  notifyBufferReady(): void {
    this._bump();
  }

  // ── Session switch ────────────────────────────────────────────────────

  /** Reset VT for a new session. */
  resetSession(): void {
    this._vt = null;
    this._bump();
  }

  // ── useSyncExternalStore integration ──────────────────────────────────

  subscribe(listener: Listener): () => void {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  }

  getSnapshot(): PtySyncSnapshot {
    return this._snapshot;
  }

  // ── Private ───────────────────────────────────────────────────────────

  private _bump(): void {
    // Snapshot and version update synchronously so callers reading
    // getSnapshot() in the same tick see fresh state.
    this._version++;
    this._snapshot = this._buildSnapshot();

    // Coalesce listener notifications to one-per-frame. PTY chunk replay can
    // call _bump() many times in rapid succession (each chunk + each xterm
    // flush callback); without coalescing, every bump fires every
    // useSyncExternalStore subscriber synchronously, producing a render storm
    // that trips React's nested-update guard via the radix Slot ref-churn
    // pattern. With rAF coalescing the storm collapses to ≤60 renders/sec
    // regardless of chunk rate.
    //
    // Underlying radix bug (open):
    //   https://github.com/radix-ui/primitives/issues/3799
    //   https://github.com/radix-ui/primitives/issues/3675
    //   https://github.com/radix-ui/primitives/pull/3835 (proposed memo fix, not merged)
    if (this._notifyScheduled) return;
    this._notifyScheduled = true;
    const fire = () => {
      this._notifyScheduled = false;
      this._notify();
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(fire);
    } else {
      // Non-DOM environments (tests, SSR): fall back to microtask.
      queueMicrotask(fire);
    }
  }

  private _buildSnapshot(): PtySyncSnapshot {
    return {
      adapter: this._adapter,
      vt: this._vt,
      version: this._version,
      refLines: this.getRefLines(),
    };
  }

  private _notify(): void {
    for (const listener of this._listeners) {
      listener();
    }
  }
}
