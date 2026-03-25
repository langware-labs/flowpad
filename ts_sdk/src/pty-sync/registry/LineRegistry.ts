import type { EnrichedChunk, ExpectedLineCoord } from '../types.js';

/**
 * Maintains lookup maps from each coordinate space to a line record.
 * Populated by calling push() for each EnrichedChunk as chunks are "injected".
 */
export class LineRegistry {
  /** logicalLine → ExpectedLineCoord */
  private byLogical = new Map<number, ExpectedLineCoord>();
  /** bufferRow → ExpectedLineCoord */
  private byBuffer = new Map<number, ExpectedLineCoord>();
  /** timestamp (ms) → ExpectedLineCoord */
  private byTimestamp = new Map<number, ExpectedLineCoord>();

  push(enriched: EnrichedChunk): void {
    for (const coord of enriched.expectedLines) {
      this.byLogical.set(coord.logicalLine, coord);
      this.byBuffer.set(coord.bufferRow, coord);
      this.byTimestamp.set(coord.timestamp, coord);
    }
  }

  /** Remove registry entries for a scrolled-off buffer row. */
  evict(bufferRow: number): void {
    const coord = this.byBuffer.get(bufferRow);
    if (coord) {
      this.byBuffer.delete(bufferRow);
      // byLogical and byTimestamp entries remain valid for timestamp/line lookups
    }
  }

  getByLogicalLine(l: number): ExpectedLineCoord | undefined {
    return this.byLogical.get(l);
  }

  getByBufferRow(r: number): ExpectedLineCoord | undefined {
    return this.byBuffer.get(r);
  }

  getByTimestamp(t: number): ExpectedLineCoord | undefined {
    return this.byTimestamp.get(t);
  }

  all(): ExpectedLineCoord[] {
    return [...this.byLogical.values()];
  }

  size(): number {
    return this.byLogical.size;
  }
}
