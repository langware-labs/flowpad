import { describe, it, expect } from 'vitest';
import { generateTestSequence } from '../generator/TestSequenceGenerator.js';
import { simulate } from '../simulator/TerminalSimulator.js';
import { StubXtermAdapter } from '../adapter/XtermAdapter.js';
import { ScrollContext } from '../scroll/ScrollContext.js';
import type { EnvSetup } from '../types.js';

describe('Test 3 — 500 Lines + Resize (seed:3)', () => {
  const envPhase1: EnvSetup = {
    cols: 80,
    rows: 24,
    cellHeight: 14,
    cellWidth: 7,
    scrollbackLines: 1000,
    seed: 3,
  };

  it('preserves logicalLine values and recalculates bufferRow after resize to cols=40', () => {
    const enriched80 = generateTestSequence(3, envPhase1, { numChunks: 500 });
    expect(enriched80.chunks).toHaveLength(500);

    const original = new Map<number, number>();
    for (const ec of enriched80.chunks) {
      for (const coord of ec.expectedLines) {
        original.set(coord.logicalLine, coord.bufferRow);
      }
    }

    const envPhase2: EnvSetup = { ...envPhase1, cols: 40 };
    const rawChunks = enriched80.chunks.map(ec => ec.chunk);
    const enriched40 = simulate(envPhase2, rawChunks);

    const resized = new Map<number, number>();
    for (const ec of enriched40.chunks) {
      for (const coord of ec.expectedLines) {
        resized.set(coord.logicalLine, coord.bufferRow);
      }
    }

    expect(resized.size).toBe(original.size);
    expect(resized.size).toBe(500);

    for (const l of original.keys()) {
      expect(resized.has(l)).toBe(true);
    }

    let narrowerCount = 0;
    for (const [l, origRow] of original) {
      const newRow = resized.get(l)!;
      expect(newRow).toBeGreaterThanOrEqual(origRow);
      if (newRow > origRow) narrowerCount++;
    }
    expect(narrowerCount).toBeGreaterThan(0);

    const adapter = new StubXtermAdapter();
    adapter.dimensions = { cols: 40, rows: 24, cellWidth: 7, cellHeight: 14, viewportPixelHeight: 336 };
    adapter.scrollState = { baseY: 0, viewportY: 0, cursorX: 0, cursorY: 0, bufferLength: 0 };

    const context = new ScrollContext(adapter);
    const decoder = new TextDecoder();

    for (const ec of enriched40.chunks) {
      const lineText = decoder.decode(ec.chunk.data).replace('\n', '');
      for (const coord of ec.expectedLines) {
        adapter.injectLine(coord.bufferRow, lineText);
      }
      context.push(ec);
    }

    const totalRows = adapter.bufferLength;
    adapter.scrollState = {
      baseY: Math.max(0, totalRows - 24),
      viewportY: 0,
      cursorX: 0,
      cursorY: 0,
      bufferLength: totalRows,
    };

    for (const ec of enriched40.chunks) {
      for (const coord of ec.expectedLines) {
        const resolved = context.resolve({ lineNumber: coord.logicalLine });
        expect(resolved).not.toBeNull();
        expect(resolved!.lineNumber).toBe(coord.logicalLine);
        expect(resolved!.bufferIndex).toBe(coord.bufferRow);

        const firstVisible = adapter.scrollState.baseY + adapter.scrollState.viewportY;
        const expectedPixelY = (coord.bufferRow - firstVisible) * 14;
        expect(resolved!.pixelY).toBe(expectedPixelY);
      }
    }
  });
});
