import type { IXtermAdapter } from '../adapter/XtermAdapter.js';
import type { EnrichedChunk, TerminalCoord } from '../types.js';
import { LineRegistry } from '../registry/LineRegistry.js';
import { CoordinateTranslator, type CoordQuery } from '../registry/CoordinateTranslator.js';

/**
 * Public façade for the xterm-scroll coordinate system.
 * Attach to an adapter, push enriched chunks as they arrive,
 * and query coordinates at any time.
 */
export class ScrollContext {
  private readonly registry: LineRegistry;
  private readonly translator: CoordinateTranslator;
  private scrollListeners: Array<() => void> = [];

  constructor(private readonly adapter: IXtermAdapter) {
    this.registry = new LineRegistry();
    this.translator = new CoordinateTranslator(this.registry, adapter);
  }

  /** Register an enriched chunk (call after simulating each OutputChunk). */
  push(enriched: EnrichedChunk): void {
    this.registry.push(enriched);
  }

  /** Resolve a coordinate query. Returns null if the line is not found. */
  resolve(query: CoordQuery): TerminalCoord | null {
    return this.translator.resolve(query);
  }

  /**
   * Returns all line records that are currently visible in the viewport,
   * with their pixelY recomputed from current scroll state.
   */
  getVisibleLines(): TerminalCoord[] {
    const { baseY, viewportY } = this.adapter.getScrollState();
    const { rows, cellHeight } = this.adapter.getDimensions();
    const firstRow = baseY + viewportY;
    const lastRow = firstRow + rows - 1;

    const visible: TerminalCoord[] = [];
    for (const coord of this.registry.all()) {
      if (coord.bufferRow >= firstRow && coord.bufferRow <= lastRow) {
        const pixelY = (coord.bufferRow - firstRow) * cellHeight;
        visible.push({
          lineNumber:   coord.logicalLine,
          bufferIndex:  coord.bufferRow,
          timestamp:    coord.timestamp,
          isoTimestamp: new Date(coord.timestamp).toISOString(),
          pixelY,
        });
      }
    }
    visible.sort((a, b) => a.bufferIndex - b.bufferIndex);
    return visible;
  }

  /** Register a listener that fires when the scroll state changes. */
  onScroll(listener: () => void): () => void {
    this.scrollListeners.push(listener);
    return () => {
      this.scrollListeners = this.scrollListeners.filter(l => l !== listener);
    };
  }

  /** Call this when xterm fires an onScroll event to notify listeners. */
  notifyScroll(): void {
    for (const l of this.scrollListeners) l();
  }

  /** Expose the underlying adapter for validation purposes. */
  getAdapter(): IXtermAdapter {
    return this.adapter;
  }
}
