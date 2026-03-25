// ─── Raw PTY data ────────────────────────────────────────────────────────────

/**
 * Mirrors Python: class OutputChunk(BaseModel)
 * One atomic chunk of bytes arriving from the PTY process.
 */
export interface OutputChunk {
  seq: number;        // Monotonic sequence number (starts at 1)
  data: Uint8Array;   // Raw PTY output bytes
  timestamp: number;  // Unix epoch milliseconds
}

// ─── The four coordinate spaces ──────────────────────────────────────────────

/**
 * A fully-resolved position in the terminal, expressed in all four spaces
 * simultaneously.
 */
export interface TerminalCoord {
  lineNumber: number;     // Absolute PTY line index, 1-based, never resets
  bufferIndex: number;    // xterm.js buffer.active row index (0-based)
  timestamp: number;      // Unix float of the chunk that wrote this line
  isoTimestamp: string;   // ISO-8601 string derived from timestamp
  pixelY: number;         // px from top of the terminal viewport
}

// ─── Line record ─────────────────────────────────────────────────────────────

export interface LineRecord {
  lineNumber: number;
  bufferIndex: number;
  chunkSeq: number;
  timestamp: number;
  content: string;
  isWrapped: boolean;
}

// ─── Terminal geometry ───────────────────────────────────────────────────────

export interface TerminalDimensions {
  cols: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  viewportPixelHeight: number;
}

// ─── Scroll state (snapshot) ─────────────────────────────────────────────────

export interface ScrollState {
  baseY: number;
  viewportY: number;
  cursorX: number;
  cursorY: number;
  bufferLength: number;
}

// ─── Enums ───────────────────────────────────────────────────────────────────

export enum CoordSpace {
  LineNumber  = 'lineNumber',
  BufferIndex = 'bufferIndex',
  Timestamp   = 'timestamp',
  PixelY      = 'pixelY',
}

export enum VisibilityState {
  AboveViewport = 'above',
  Visible       = 'visible',
  BelowViewport = 'below',
}

// ─── Environment setup ───────────────────────────────────────────────────────

export interface EnvSetup {
  cols: number;
  rows: number;
  cellHeight: number;
  cellWidth: number;
  scrollbackLines: number;
  seed: number;
}

// ─── Enriched simulation types ───────────────────────────────────────────────

export interface ExpectedLineCoord {
  logicalLine: number;   // l
  bufferRow: number;     // r (env-dependent)
  timestamp: number;     // t (synthetic, seeded, ms epoch)
  pixelY: number;        // (bufferRow - firstVisibleRow) * cellHeight
}

export interface EnrichedChunk {
  chunk: OutputChunk;
  expectedLines: ExpectedLineCoord[];
}

export interface EnrichedSequence {
  env: EnvSetup;
  chunks: EnrichedChunk[];
}

// ─── Validation ──────────────────────────────────────────────────────────────

export interface ValidationResult {
  chunkSeq: number;
  logicalLine: number;
  pass: boolean;
  failures: Array<{ field: string; expected: unknown; actual: unknown }>;
}

export interface ValidationReport {
  seed: number;
  env: EnvSetup;
  totalChecked: number;
  totalPassed: number;
  results: ValidationResult[];
}

// ─── Test sequence ───────────────────────────────────────────────────────────

export interface TestSequence {
  description: string;
  terminalCols: number;
  terminalRows: number;
  chunks: OutputChunk[];
  expectedSnapshots?: CoordSnapshot[];
}

export interface CoordSnapshot {
  querySpace: CoordSpace;
  queryValue: number;
  expected: Partial<TerminalCoord>;
}

// ─── VirtualTerminal types ───────────────────────────────────────────────────

export interface VirtualRow {
  content: string;           // plain text, ANSI stripped, cells joined
  ownerSeq: number | null;   // last packet seq that wrote here
  logicalLine: number | null; // null for wrap continuations and empty rows
  isWrapped: boolean;
  status: 'live' | 'scrolled_off';
}

export interface PacketRowRecord {
  bufferRow: number;         // absolute index (totalScrolledOff + liveIndex)
  logicalLine: number | null;
  status: 'live' | 'overwritten' | 'scrolled_off';
  overwrittenBySeq?: number;
}

export interface PacketSimResult {
  seq: number;
  timestamp: number;
  rows: PacketRowRecord[];
}

export interface SimulationReport {
  env: EnvSetup;
  virtualBuffer: VirtualRow[];
  packetResults: PacketSimResult[];
  finalCursorRow: number;
  finalCursorCol: number;
  totalScrolledOff: number;
}

// ─── PlaybackHarness types ───────────────────────────────────────────────────

export interface PlaybackValidationReport {
  totalRows: number;
  matchedRows: number;
  failures: Array<{ bufferRow: number; predicted: string; actual: string | null }>;
}

// ─── Bridge function ─────────────────────────────────────────────────────────

/**
 * Convert SimulationReport → EnrichedSequence so existing validate() callers
 * work unchanged.
 */
export function simulationReportToEnrichedSequence(
  report: SimulationReport,
  chunks: OutputChunk[],
): EnrichedSequence {
  const { env } = report;

  // Index packetResults by seq for O(1) lookup (avoid O(chunks²) find)
  const resultBySeq = new Map(report.packetResults.map(r => [r.seq, r]));

  const enrichedChunks: EnrichedChunk[] = chunks.map(chunk => {
    const packetResult = resultBySeq.get(chunk.seq);
    const expectedLines: ExpectedLineCoord[] = [];

    if (packetResult) {
      for (const row of packetResult.rows) {
        if (row.logicalLine !== null && row.status !== 'overwritten') {
          expectedLines.push({
            logicalLine: row.logicalLine,
            bufferRow: row.bufferRow,
            timestamp: packetResult.timestamp,
            pixelY: row.bufferRow * env.cellHeight,
          });
        }
      }
    }

    return { chunk, expectedLines };
  });

  return { env, chunks: enrichedChunks };
}
