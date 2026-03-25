import type { IXtermAdapter } from '../adapter/XtermAdapter.js';
import type { TerminalCoord } from '../types.js';
import type { LineRegistry } from './LineRegistry.js';

export interface CoordQuery {
  lineNumber?: number;
  bufferIndex?: number;
  timestamp?: number;
  pixelY?: number;
}

/**
 * Resolves a query in any coordinate space to a full TerminalCoord,
 * using the LineRegistry for stored data and the adapter for live state.
 */
export class CoordinateTranslator {
  constructor(
    private readonly registry: LineRegistry,
    private readonly adapter: IXtermAdapter,
  ) {}

  resolve(query: CoordQuery): TerminalCoord | null {
    const coord = this.findCoord(query);
    if (!coord) return null;

    const { baseY, viewportY } = this.adapter.getScrollState();
    const { cellHeight } = this.adapter.getDimensions();
    const firstVisibleRow = baseY + viewportY;
    const pixelY = (coord.bufferRow - firstVisibleRow) * cellHeight;

    return {
      lineNumber:    coord.logicalLine,
      bufferIndex:   coord.bufferRow,
      timestamp:     coord.timestamp,
      isoTimestamp:  new Date(coord.timestamp).toISOString(),
      pixelY,
    };
  }

  private findCoord(query: CoordQuery) {
    if (query.lineNumber !== undefined) {
      return this.registry.getByLogicalLine(query.lineNumber);
    }
    if (query.bufferIndex !== undefined) {
      return this.registry.getByBufferRow(query.bufferIndex);
    }
    if (query.timestamp !== undefined) {
      return this.registry.getByTimestamp(query.timestamp);
    }
    if (query.pixelY !== undefined) {
      const bufferIndex = this.adapter.pixelYToBufferIndex(query.pixelY);
      return this.registry.getByBufferRow(bufferIndex);
    }
    return undefined;
  }
}
