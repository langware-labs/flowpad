import type { IXtermAdapter } from '../adapter/XtermAdapter.js';
import type { ExpectedLineCoord } from '../types.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * A snapshot of stream-level scroll and time metrics, computed from the
 * current adapter state and the full set of known packet coordinates.
 *
 * Timestamp is the primary sync key: every component uses it to position
 * its indicator relative to the full time range of the stream.
 */
export interface StreamMetrics {
  // Buffer-domain (scroll position in row space)
  totalBufferRows: number;     // adapter.getScrollState().bufferLength
  visibleRows: number;         // terminal rows
  firstVisibleRow: number;     // baseY + viewportY
  lastVisibleRow: number;      // firstVisibleRow + visibleRows - 1
  scrollFraction: number;      // [0,1] — 0=top, 1=fully scrolled down

  // Time-domain (position in timestamp space)
  minTimestamp: number;        // earliest packet timestamp in the stream
  maxTimestamp: number;        // latest packet timestamp in the stream
  centerTimestamp: number;     // timestamp nearest to the center of the viewport
  timeFraction: number;        // [0,1] — where centerTimestamp falls in [min,max]

  // Display geometry
  cellHeight: number;
  viewportPixelHeight: number;

  // All packet coords sorted by timestamp (for canvas drawing)
  coords: ExpectedLineCoord[];

  // Eviction offset: rows xterm has scrolled off (= VT totalScrolledOff)
  evictionOffset: number;
}

// ─── Computation ─────────────────────────────────────────────────────────────

/**
 * Compute StreamMetrics from live adapter state and a snapshot of all known
 * packet coordinates (e.g. from LineRegistry.all()).
 *
 * Pure function — no side effects, easy to unit-test.
 */
export function computeStreamMetrics(
  adapter: IXtermAdapter,
  allCoords: ExpectedLineCoord[],
): StreamMetrics {
  const { baseY, viewportY, bufferLength } = adapter.getScrollState();
  const { rows, cellHeight, viewportPixelHeight } = adapter.getDimensions();

  const firstVisibleRow = baseY + viewportY;
  const lastVisibleRow  = firstVisibleRow + rows - 1;

  // scrollFraction: 0 = top, 1 = bottom.
  // When at top: firstVisibleRow = 0 → 0 / baseY = 0.
  // When at bottom: firstVisibleRow = baseY → baseY / baseY = 1.
  const scrollFraction = baseY <= 0 ? 1 : Math.min(1, Math.max(0, firstVisibleRow / baseY));

  // Sort all coords by timestamp
  const coords = [...allCoords].sort((a, b) => a.timestamp - b.timestamp);

  const minTimestamp = coords.length > 0 ? coords[0].timestamp : 0;
  const maxTimestamp = coords.length > 0 ? coords[coords.length - 1].timestamp : 0;
  const timeRange    = maxTimestamp - minTimestamp;

  // Find the coord whose bufferRow is nearest to the center of the viewport.
  // coords[].bufferRow is in VT-absolute space; translate firstVisibleRow to match.
  const evictionOffset = adapter.getEvictionOffset();
  const firstVisibleRowAbs = firstVisibleRow + evictionOffset;
  const centerRow = firstVisibleRowAbs + Math.floor(rows / 2);
  let centerTimestamp = minTimestamp;
  if (coords.length > 0) {
    let bestDist = Infinity;
    for (const c of coords) {
      const dist = Math.abs(c.bufferRow - centerRow);
      if (dist < bestDist) { bestDist = dist; centerTimestamp = c.timestamp; }
    }
  }

  const timeFraction = timeRange <= 0
    ? 0
    : Math.min(1, Math.max(0, (centerTimestamp - minTimestamp) / timeRange));

  return {
    totalBufferRows: bufferLength,
    visibleRows:     rows,
    firstVisibleRow,
    lastVisibleRow,
    scrollFraction,
    minTimestamp,
    maxTimestamp,
    centerTimestamp,
    timeFraction,
    cellHeight,
    viewportPixelHeight,
    coords,
    evictionOffset,
  };
}
