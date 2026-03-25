import type { Terminal, IBufferLine } from '@xterm/xterm';
import type { TerminalDimensions, ScrollState } from '../types.js';

// ─── Interface ───────────────────────────────────────────────────────────────

export interface IXtermAdapter {
  getBufferLength(): number;
  getScrollState(): ScrollState;
  getDimensions(): TerminalDimensions;
  getBufferLine(bufferIndex: number): IBufferLine | null;
  getLineText(bufferIndex: number): string | null;
  bufferIndexToPixelY(bufferIndex: number): number;
  pixelYToBufferIndex(pixelY: number): number;
  /** Scroll the terminal viewport to center on the given buffer row. */
  scrollToRow(bufferRow: number): void;
  /** Scroll the terminal viewport to an absolute fraction [0=top, 1=bottom]. */
  scrollToFraction(fraction: number): void;
  /** Number of rows xterm has evicted from its buffer (matches VT totalScrolledOff). */
  getEvictionOffset(): number;
}

// ─── Live adapter ────────────────────────────────────────────────────────────

export class LiveXtermAdapter implements IXtermAdapter {
  private _evictionOffset = 0;

  constructor(private readonly term: Terminal) {}

  setEvictionOffset(n: number): void { this._evictionOffset = n; }
  getEvictionOffset(): number { return this._evictionOffset; }

  getBufferLength(): number {
    return this.term.buffer.active.length;
  }

  getScrollState(): ScrollState {
    const buf = this.term.buffer.active;
    return {
      baseY:        buf.baseY,
      viewportY:    buf.viewportY - buf.baseY,
      cursorX:      buf.cursorX,
      cursorY:      buf.cursorY,
      bufferLength: buf.length,
    };
  }

  getDimensions(): TerminalDimensions {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dims = (this.term as any)._core?.renderService?.dimensions;
    const cellWidth  = dims?.css?.cell?.width  ?? this.term.element!.clientWidth  / this.term.cols;
    const cellHeight = dims?.css?.cell?.height ?? this.term.element!.clientHeight / this.term.rows;

    return {
      cols:                this.term.cols,
      rows:                this.term.rows,
      cellWidth,
      cellHeight,
      viewportPixelHeight: cellHeight * this.term.rows,
    };
  }

  getBufferLine(absRow: number): IBufferLine | null {
    return this.term.buffer.active.getLine(absRow - this._evictionOffset) ?? null;
  }

  getLineText(bufferIndex: number): string | null {
    const line = this.getBufferLine(bufferIndex);
    return line ? line.translateToString(true) : null;
  }

  bufferIndexToPixelY(absRow: number): number {
    const { baseY, viewportY } = this.getScrollState();
    const { cellHeight } = this.getDimensions();
    const firstVisibleRowLive = baseY + viewportY;
    return (absRow - this._evictionOffset - firstVisibleRowLive) * cellHeight;
  }

  pixelYToBufferIndex(pixelY: number): number {
    const { baseY, viewportY } = this.getScrollState();
    const { cellHeight } = this.getDimensions();
    const firstVisibleRowLive = baseY + viewportY;
    return firstVisibleRowLive + this._evictionOffset + Math.floor(pixelY / cellHeight);
  }

  scrollToRow(absRow: number): void {
    const { baseY, viewportY } = this.getScrollState();
    const { rows } = this.getDimensions();
    const currentFirstRowLive = baseY + viewportY;
    const desiredFirstRowLive = Math.max(0, (absRow - this._evictionOffset) - Math.floor(rows / 2));
    const lineDelta = desiredFirstRowLive - currentFirstRowLive;
    if (lineDelta !== 0) this.term.scrollLines(lineDelta);
  }

  scrollToFraction(fraction: number): void {
    const viewport = this.term.element?.querySelector('.xterm-viewport') as HTMLElement | null;
    if (!viewport) return;
    const { baseY } = this.getScrollState();
    const { cellHeight } = this.getDimensions();
    viewport.scrollTop = Math.max(0, Math.min(1, fraction)) * baseY * cellHeight;
  }
}

// ─── Stub adapter ────────────────────────────────────────────────────────────

export class StubXtermAdapter implements IXtermAdapter {
  public bufferLength   = 0;
  public scrollState: ScrollState = {
    baseY: 0, viewportY: 0, cursorX: 0, cursorY: 0, bufferLength: 0,
  };
  public dimensions: TerminalDimensions = {
    cols: 80, rows: 24, cellWidth: 7, cellHeight: 14, viewportPixelHeight: 336,
  };
  public evictionOffset = 0;

  private lines = new Map<number, string>();

  injectLine(bufferIndex: number, text: string): void {
    this.lines.set(bufferIndex, text);
    this.bufferLength = Math.max(this.bufferLength, bufferIndex + 1);
    this.scrollState.bufferLength = this.bufferLength;
  }

  getBufferLength()                         { return this.bufferLength; }
  getScrollState()                          { return { ...this.scrollState }; }
  getDimensions()                           { return { ...this.dimensions }; }
  getBufferLine(_i: number)                 { return null; }
  getLineText(absRow: number)               { return this.lines.get(absRow) ?? null; }
  getEvictionOffset(): number               { return this.evictionOffset; }

  bufferIndexToPixelY(absRow: number): number {
    const firstVisibleRowLive = this.scrollState.baseY + this.scrollState.viewportY;
    return (absRow - this.evictionOffset - firstVisibleRowLive) * this.dimensions.cellHeight;
  }

  pixelYToBufferIndex(pixelY: number): number {
    const firstVisibleRowLive = this.scrollState.baseY + this.scrollState.viewportY;
    return firstVisibleRowLive + this.evictionOffset + Math.floor(pixelY / this.dimensions.cellHeight);
  }

  scrollToRow(absRow: number): void {
    const { rows } = this.dimensions;
    const desiredFirstRowLive = Math.max(0, (absRow - this.evictionOffset) - Math.floor(rows / 2));
    this.scrollState.viewportY = desiredFirstRowLive - this.scrollState.baseY;
  }

  scrollToFraction(fraction: number): void {
    const f = Math.max(0, Math.min(1, fraction));
    this.scrollState.viewportY = Math.round(f * this.scrollState.baseY) - this.scrollState.baseY;
  }
}
