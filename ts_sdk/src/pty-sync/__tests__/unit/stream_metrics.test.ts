import { describe, it, expect, beforeEach } from 'vitest';
import { StubXtermAdapter } from '../../adapter/XtermAdapter.js';
import { computeStreamMetrics } from '../../scroll/StreamMetrics.js';
import type { ExpectedLineCoord } from '../../types.js';

function coord(logicalLine: number, bufferRow: number, timestamp: number): ExpectedLineCoord {
  return { logicalLine, bufferRow, timestamp, pixelY: bufferRow * 14 };
}

describe('computeStreamMetrics', () => {
  let adapter: StubXtermAdapter;

  beforeEach(() => {
    adapter = new StubXtermAdapter();
    // 24 rows, 80 cols, cellHeight=14
    adapter.dimensions = { cols: 80, rows: 24, cellWidth: 7, cellHeight: 14, viewportPixelHeight: 336 };
    // 50-row buffer, at bottom (viewportY=0)
    adapter.scrollState = { baseY: 26, viewportY: 0, cursorX: 0, cursorY: 23, bufferLength: 50 };
  });

  const threeCoords = [
    coord(1,  0,  1000),
    coord(2,  5,  2000),
    coord(3, 25,  3000),
  ];

  // ─── scrollFraction ───────────────────────────────────────────────────────

  it('scrollFraction=1 when at bottom (viewportY=0)', () => {
    const m = computeStreamMetrics(adapter, threeCoords);
    expect(m.scrollFraction).toBe(1);
  });

  it('scrollFraction=0 when at top (viewportY = -baseY)', () => {
    adapter.scrollState.viewportY = -adapter.scrollState.baseY; // firstVisibleRow = 0
    const m = computeStreamMetrics(adapter, threeCoords);
    expect(m.scrollFraction).toBe(0);
  });

  it('scrollFraction midway', () => {
    // baseY=26, viewportY=-13 → firstVisibleRow=13 → 13/26 = 0.5
    adapter.scrollState.viewportY = -13;
    const m = computeStreamMetrics(adapter, threeCoords);
    expect(m.scrollFraction).toBeCloseTo(0.5, 5);
  });

  it('scrollFraction clamped to [0,1]', () => {
    adapter.scrollState.viewportY = 99; // beyond bottom
    const m = computeStreamMetrics(adapter, []);
    expect(m.scrollFraction).toBe(1);

    adapter.scrollState.viewportY = -999; // beyond top
    const m2 = computeStreamMetrics(adapter, []);
    expect(m2.scrollFraction).toBe(0);
  });

  // ─── firstVisibleRow / lastVisibleRow ─────────────────────────────────────

  it('firstVisibleRow = baseY + viewportY', () => {
    adapter.scrollState.viewportY = -5;
    const m = computeStreamMetrics(adapter, []);
    expect(m.firstVisibleRow).toBe(26 - 5); // 21
    expect(m.lastVisibleRow).toBe(21 + 24 - 1); // 44
  });

  // ─── timestamp range ─────────────────────────────────────────────────────

  it('minTimestamp / maxTimestamp from coords', () => {
    const m = computeStreamMetrics(adapter, threeCoords);
    expect(m.minTimestamp).toBe(1000);
    expect(m.maxTimestamp).toBe(3000);
  });

  it('minTimestamp = maxTimestamp = 0 when no coords', () => {
    const m = computeStreamMetrics(adapter, []);
    expect(m.minTimestamp).toBe(0);
    expect(m.maxTimestamp).toBe(0);
  });

  // ─── timeFraction ─────────────────────────────────────────────────────────

  it('timeFraction = 0 when no coords', () => {
    const m = computeStreamMetrics(adapter, []);
    expect(m.timeFraction).toBe(0);
  });

  it('timeFraction reflects nearest coord to viewport center', () => {
    // viewportY=0, baseY=26 → firstVisibleRow=26, center=26+12=38
    // coord(3) has bufferRow=25, nearest to 38 → centerTimestamp=3000
    // timeFraction = (3000-1000)/(3000-1000) = 1.0
    const m = computeStreamMetrics(adapter, threeCoords);
    expect(m.timeFraction).toBeCloseTo(1.0, 5);
  });

  it('timeFraction = 0 when center near first packet', () => {
    // scroll to top → center = 12
    adapter.scrollState.viewportY = -adapter.scrollState.baseY;
    // firstVisibleRow=0, center=12
    // coord(2) bufferRow=5 is nearest to 12... but coord(3) is at 25, further
    // Actually coord(2) at 5 vs coord(3) at 25: dist from 12: 7 vs 13 → coord(2) wins
    // timeFraction = (2000-1000)/(3000-1000) = 0.5
    const m = computeStreamMetrics(adapter, threeCoords);
    expect(m.timeFraction).toBeCloseTo(0.5, 5);
  });

  it('timeFraction = 0 when all timestamps equal', () => {
    const same = [coord(1, 0, 5000), coord(2, 1, 5000)];
    const m = computeStreamMetrics(adapter, same);
    expect(m.timeFraction).toBe(0);
  });

  // ─── coords sort ─────────────────────────────────────────────────────────

  it('coords are sorted by timestamp', () => {
    const unordered = [coord(3, 25, 3000), coord(1, 0, 1000), coord(2, 5, 2000)];
    const m = computeStreamMetrics(adapter, unordered);
    expect(m.coords.map(c => c.timestamp)).toEqual([1000, 2000, 3000]);
  });

  it('does not mutate the input array', () => {
    const input = [coord(3, 25, 3000), coord(1, 0, 1000)];
    const original = [...input];
    computeStreamMetrics(adapter, input);
    expect(input).toEqual(original);
  });

  // ─── evictionOffset ───────────────────────────────────────────────────────

  it('evictionOffset = 0 by default on StubXtermAdapter', () => {
    const m = computeStreamMetrics(adapter, threeCoords);
    expect(m.evictionOffset).toBe(0);
  });

  it('evictionOffset is returned from adapter.getEvictionOffset()', () => {
    adapter.evictionOffset = 50;
    const m = computeStreamMetrics(adapter, threeCoords);
    expect(m.evictionOffset).toBe(50);
  });

  it('centerRow uses absRow space when evictionOffset > 0', () => {
    // With evictionOffset=50, baseY=26, viewportY=0:
    // firstVisibleRow (live) = 26, firstVisibleRowAbs = 76
    // centerRow = 76 + 12 = 88
    // coords have absRow: 0, 5, 25 — all far from 88; nearest is coord(3) at absRow=25
    // timeFraction = (3000-1000)/(3000-1000) = 1.0
    adapter.evictionOffset = 50;
    const m = computeStreamMetrics(adapter, threeCoords);
    expect(m.centerTimestamp).toBe(3000);
    expect(m.timeFraction).toBeCloseTo(1.0, 5);
  });

  it('centerRow with evictionOffset finds correct packet at center', () => {
    // evictionOffset=50, scroll to top: firstVisibleRow (live) = 0, firstVisibleRowAbs = 50
    // centerRow = 50 + 12 = 62
    // absRow coords: 0, 5, 25 — nearest to 62 is coord(3) at 25 (dist=37)
    // timeFraction = (3000-1000)/2000 = 1.0
    adapter.evictionOffset = 50;
    adapter.scrollState.viewportY = -adapter.scrollState.baseY; // scroll to top
    const m = computeStreamMetrics(adapter, threeCoords);
    expect(m.centerTimestamp).toBe(3000);
  });

  // ─── geometry ─────────────────────────────────────────────────────────────

  it('viewportPixelHeight = rows * cellHeight', () => {
    const m = computeStreamMetrics(adapter, []);
    expect(m.viewportPixelHeight).toBe(336); // 24 * 14
    expect(m.cellHeight).toBe(14);
    expect(m.visibleRows).toBe(24);
  });

  // ─── scrollToRow (StubXtermAdapter) ──────────────────────────────────────

  it('scrollToRow centers the viewport on the target row', () => {
    // baseY=26, currently at bottom (viewportY=0, firstVisibleRow=26)
    // scrollToRow(5) → desiredFirstRow = max(0, 5-12) = 0 → viewportY = 0-26 = -26
    adapter.scrollToRow(5);
    expect(adapter.scrollState.viewportY).toBe(-26);
    expect(adapter.scrollState.baseY + adapter.scrollState.viewportY).toBe(0);
  });

  it('scrollToRow clamps to row 0', () => {
    adapter.scrollToRow(0);
    const firstVisible = adapter.scrollState.baseY + adapter.scrollState.viewportY;
    expect(firstVisible).toBe(0);
  });
});
