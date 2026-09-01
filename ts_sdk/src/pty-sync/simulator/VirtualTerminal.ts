import { parseAnsi } from './AnsiParser.js';
import { charWidth } from './CharWidth.js';
import { parseTag } from './parse-tag.js';
import type {
  EnvSetup,
  OutputChunk,
  PacketSimResult,
  PacketRowRecord,
  SimulationReport,
  VirtualRow,
} from '../types.js';

interface RowMeta {
  ownerSeq: number | null;
  logicalLine: number | null;
  isWrapped: boolean;
}

export interface RowSyncData {
  absRow: number;
  ownerSeq: number | null;
  logicalLine: number | null;
  timestamp: number | null;
}

/**
 * Core terminal emulator. Processes OutputChunks maintaining full buffer state
 * with ANSI-aware column counting, deferred-wrap, and row ownership tracking.
 *
 * cursorRow = live index (0-based into cells[]).
 * absolute bufferRow = cursorRow + totalScrolledOff.
 */
export class VirtualTerminal {
  private cells: string[][];   // cells[liveIdx][col]
  private rowMeta: RowMeta[];
  private cursorRow = 0;       // live index
  private cursorCol = 0;
  private pendingWrap = false;
  private totalScrolledOff = 0;
  private readonly packetResults = new Map<number, PacketSimResult>();
  private readonly cols: number;
  private readonly maxBufferRows: number;
  private readonly env: EnvSetup;
  private readonly decoder = new TextDecoder();
  // Reverse index: absRow → currently live PacketRowRecord for that row.
  // Enables O(1) ownership transfer and O(1) eviction instead of O(P×R) scans.
  private readonly liveRowIndex = new Map<number, PacketRowRecord>();

  constructor(env: EnvSetup) {
    this.env = env;
    this.cols = env.cols;
    this.maxBufferRows = env.rows + env.scrollbackLines;
    this.cells = [new Array<string>(env.cols).fill(' ')];
    this.rowMeta = [{ ownerSeq: null, logicalLine: null, isWrapped: false }];
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  processChunk(chunk: OutputChunk): PacketSimResult {
    const result: PacketSimResult = {
      seq: chunk.seq,
      timestamp: chunk.timestamp,
      rows: [],
    };

    const events = parseAnsi(this.decoder.decode(chunk.data));
    const seenAbsRows = new Set<number>();

    for (const event of events) {
      switch (event.type) {
        case 'print': {
          const cp = event.char.codePointAt(0) ?? 32;
          const w = charWidth(cp);

          // Resolve deferred wrap before writing
          if (this.pendingWrap) {
            this._doWrap();
            this.pendingWrap = false;
          }

          // Wide char that doesn't fit: wrap first
          if (w === 2 && this.cursorCol + 2 > this.cols) {
            this._doWrap();
          }

          const absRow = this._absRow();
          this._ensureRow(this.cursorRow);
          this._writeCell(absRow, this.cursorCol, event.char, chunk.seq);
          seenAbsRows.add(absRow);

          if (w === 2) {
            // Write placeholder for second cell
            if (this.cursorCol + 1 < this.cols) {
              this._writeCell(absRow, this.cursorCol + 1, '\x00', chunk.seq);
            }
            this.cursorCol += 2;
          } else if (w === 0) {
            // Combining mark: don't advance
          } else {
            this.cursorCol++;
          }

          if (this.cursorCol >= this.cols) {
            this.pendingWrap = true;
            this.cursorCol = this.cols - 1; // stay at last col per xterm behaviour
          }
          break;
        }

        case 'cr': {
          this.pendingWrap = false;
          this.cursorCol = 0;
          break;
        }

        case 'lf': {
          this.pendingWrap = false;
          this.cursorRow++;
          this.cursorCol = 0;
          this._ensureRow(this.cursorRow);
          this._scrollIfNeeded();
          seenAbsRows.add(this._absRow());
          break;
        }

        case 'tab': {
          if (this.pendingWrap) {
            this._doWrap();
            this.pendingWrap = false;
          }
          const nextStop = Math.ceil((this.cursorCol + 1) / 8) * 8;
          this.cursorCol = Math.min(nextStop, this.cols - 1);
          if (nextStop >= this.cols) {
            this.pendingWrap = true;
          }
          break;
        }

        case 'csi': {
          this._handleCSI(event.cmd, event.params);
          break;
        }

        default:
          break;
      }
    }

    // Tag detection: scan rows this chunk owns (non-wrapped) for embedded tags
    this._tagDetectionPass(chunk.seq);

    // Build row records from seenAbsRows and register them in the live index
    for (const absRow of seenAbsRows) {
      const liveIdx = absRow - this.totalScrolledOff;
      if (liveIdx >= 0 && liveIdx < this.rowMeta.length) {
        const meta = this.rowMeta[liveIdx];
        if (meta.ownerSeq === chunk.seq) {
          const record: PacketRowRecord = {
            bufferRow: absRow,
            logicalLine: meta.logicalLine,
            status: 'live',
          };
          result.rows.push(record);
          this.liveRowIndex.set(absRow, record);
        }
      } else {
        result.rows.push({ bufferRow: absRow, logicalLine: null, status: 'scrolled_off' });
      }
    }

    // Register so future chunks can update our row records via liveRowIndex
    this.packetResults.set(chunk.seq, result);

    return result;
  }

  getReport(): SimulationReport {
    const virtualBuffer: VirtualRow[] = this.cells.map((_, i) => ({
      content: this._rowText(i),
      ownerSeq: this.rowMeta[i].ownerSeq,
      logicalLine: this.rowMeta[i].logicalLine,
      isWrapped: this.rowMeta[i].isWrapped,
      status: 'live' as const,
    }));

    return {
      env: this.env,
      virtualBuffer,
      packetResults: [...this.packetResults.values()],
      finalCursorRow: this.cursorRow + this.totalScrolledOff, // absolute row
      finalCursorCol: this.cursorCol,
      totalScrolledOff: this.totalScrolledOff,
    };
  }

  /**
   * Lightweight getter: absolute cursor row without building a full report.
   * Equivalent to getReport().finalCursorRow but O(1) instead of O(buffer).
   */
  getCursorRow(): number {
    return this.cursorRow + this.totalScrolledOff;
  }

  /**
   * Lightweight getter: total rows scrolled off the top of the buffer.
   * Equivalent to getReport().totalScrolledOff but avoids report serialization.
   */
  getTotalScrolledOff(): number {
    return this.totalScrolledOff;
  }

  /**
   * Returns per-row sync metadata for a range of viewport rows.
   * Used by TimeGutter to display debug coordinates alongside the terminal.
   */
  getRowDataRange(startAbsRow: number, count: number): RowSyncData[] {
    const result: RowSyncData[] = [];
    for (let i = 0; i < count; i++) {
      const absRow = startAbsRow + i;
      const liveIdx = absRow - this.totalScrolledOff;
      if (liveIdx < 0 || liveIdx >= this.rowMeta.length) {
        result.push({ absRow, ownerSeq: null, logicalLine: null, timestamp: null });
        continue;
      }
      const meta = this.rowMeta[liveIdx];
      const ts = meta.ownerSeq !== null ? (this.packetResults.get(meta.ownerSeq)?.timestamp ?? null) : null;
      result.push({ absRow, ownerSeq: meta.ownerSeq, logicalLine: meta.logicalLine, timestamp: ts });
    }
    return result;
  }

  // ─── Internal helpers ────────────────────────────────────────────────────────

  private _absRow(): number {
    return this.cursorRow + this.totalScrolledOff;
  }

  /** Render a live row to plain text (null bytes become spaces). */
  private _rowText(liveIdx: number): string {
    return this.cells[liveIdx].join('').replace(/\x00/g, ' ');
  }

  private _ensureRow(liveIdx: number): void {
    while (this.cells.length <= liveIdx) {
      this.cells.push(new Array<string>(this.cols).fill(' '));
      this.rowMeta.push({ ownerSeq: null, logicalLine: null, isWrapped: false });
    }
  }

  private _doWrap(): void {
    this.cursorRow++;
    this.cursorCol = 0;
    this._ensureRow(this.cursorRow);
    this.rowMeta[this.cursorRow].isWrapped = true;
    this._scrollIfNeeded();
  }

  private _scrollIfNeeded(): void {
    while (this.cells.length > this.maxBufferRows) {
      this._evict();
    }
  }

  private _evict(): void {
    const evictedAbsRow = this.totalScrolledOff;
    // O(1) lookup via reverse index instead of O(P×R) scan
    const record = this.liveRowIndex.get(evictedAbsRow);
    if (record) {
      record.status = 'scrolled_off';
      this.liveRowIndex.delete(evictedAbsRow);
    }
    this.cells.shift();
    this.rowMeta.shift();
    this.totalScrolledOff++;
    this.cursorRow--; // live index shifts down with the array
  }

  private _writeCell(absRow: number, col: number, ch: string, seq: number): void {
    const liveIdx = absRow - this.totalScrolledOff;
    if (liveIdx < 0 || liveIdx >= this.cells.length) return;

    const meta = this.rowMeta[liveIdx];

    // Ownership transfer: if row is owned by a different packet, mark it overwritten.
    // O(1) via liveRowIndex instead of scanning oldResult.rows.
    if (meta.ownerSeq !== null && meta.ownerSeq !== seq) {
      const oldRecord = this.liveRowIndex.get(absRow);
      if (oldRecord && oldRecord.status === 'live') {
        oldRecord.status = 'overwritten';
        oldRecord.overwrittenBySeq = seq;
        this.liveRowIndex.delete(absRow);
      }
      meta.logicalLine = null;
      meta.ownerSeq = seq;
    } else if (meta.ownerSeq === null) {
      meta.ownerSeq = seq;
    }

    this.cells[liveIdx][col] = ch;
  }

  private _tagDetectionPass(seq: number): void {
    for (let liveIdx = 0; liveIdx < this.rowMeta.length; liveIdx++) {
      const meta = this.rowMeta[liveIdx];
      if (meta.ownerSeq !== seq || meta.isWrapped) continue;

      // Gather this row + any consecutive wrapped continuations with the same owner.
      // The tag may span rows when cols < TAG_LENGTH (e.g. cols=40, tag=42 chars).
      let content = this._rowText(liveIdx);
      let nextIdx = liveIdx + 1;
      while (
        content.length < 42 &&
        nextIdx < this.rowMeta.length &&
        this.rowMeta[nextIdx].isWrapped &&
        this.rowMeta[nextIdx].ownerSeq === seq
      ) {
        content += this._rowText(nextIdx);
        nextIdx++;
      }

      const parsed = parseTag(content.slice(0, 42));
      if (parsed) {
        meta.logicalLine = parsed.logicalLine;
      }
    }
  }

  private _handleCSI(cmd: string, params: number[]): void {
    const p1 = params[0] ?? 1;
    const p2 = params[1] ?? 1;

    switch (cmd) {
      case 'A': // cursor up
        this.cursorRow = Math.max(0, this.cursorRow - p1);
        this.pendingWrap = false;
        break;
      case 'B': // cursor down
        this.cursorRow += p1;
        this._ensureRow(this.cursorRow);
        this._scrollIfNeeded();
        this.pendingWrap = false;
        break;
      case 'C': // cursor right
        this.cursorCol = Math.min(this.cols - 1, this.cursorCol + p1);
        this.pendingWrap = false;
        break;
      case 'D': // cursor left
        this.cursorCol = Math.max(0, this.cursorCol - p1);
        this.pendingWrap = false;
        break;
      case 'H': // cursor position (1-based row;col)
      case 'f': {
        const row = (params[0] ?? 1) - 1;
        const col = (p2) - 1;
        this.cursorRow = Math.max(0, row);
        this.cursorCol = Math.max(0, Math.min(this.cols - 1, col));
        this._ensureRow(this.cursorRow);
        this.pendingWrap = false;
        break;
      }
      case 'J': // erase display
        if (params[0] === 2) {
          for (const row of this.cells) row.fill(' ');
        }
        break;
      case 'K': // erase line
        if (params[0] === 2 || params[0] === undefined) {
          if (this.cursorRow < this.cells.length) {
            this.cells[this.cursorRow].fill(' ');
          }
        }
        break;
      case 'm': // SGR — color/style, no action needed
        break;
      default:
        break;
    }
  }
}
