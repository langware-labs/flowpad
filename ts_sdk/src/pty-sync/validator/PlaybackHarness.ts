import type { SimulationReport, PlaybackValidationReport } from '../types.js';
import type { IXtermAdapter } from '../adapter/XtermAdapter.js';
import { validateBufferRows } from './Validator.js';

/**
 * Replays a SimulationReport into any IXtermAdapter and validates the result.
 * Designed for future browser E2E use with LiveXtermAdapter + Playwright.
 */
export class PlaybackHarness {
  constructor(
    private readonly report: SimulationReport,
    private readonly adapter: IXtermAdapter,
  ) {}

  /**
   * Replay the simulation into a live terminal by calling writeFn for each
   * original chunk's data. The adapter must be connected to a real xterm.js
   * Terminal that receives the written data.
   */
  async replay(writeFn: (data: Uint8Array) => Promise<void>): Promise<void> {
    // Reconstruct original chunks from report context
    // This is a stub — real implementation needs the original OutputChunk[]
    // which LiveXtermAdapter would hold.
    void writeFn; // suppress unused warning in stub
  }

  /**
   * For StubXtermAdapter: inject all live rows from the report.
   */
  injectIntoStub(injectFn: (bufferRow: number, content: string) => void): void {
    for (let i = 0; i < this.report.virtualBuffer.length; i++) {
      const row = this.report.virtualBuffer[i];
      const absRow = this.report.totalScrolledOff + i;
      injectFn(absRow, row.content);
    }
  }

  /** Validate adapter buffer against predicted virtual buffer. */
  validateBuffer(): PlaybackValidationReport {
    return validateBufferRows(this.report, this.adapter);
  }
}
