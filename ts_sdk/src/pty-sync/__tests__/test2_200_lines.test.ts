import { describe, it, expect } from 'vitest';
import { generateTestSequence } from '../generator/TestSequenceGenerator.js';
import { StubXtermAdapter } from '../adapter/XtermAdapter.js';
import { ScrollContext } from '../scroll/ScrollContext.js';
import { validate } from '../validator/Validator.js';
import type { EnvSetup } from '../types.js';

describe('Test 2 — 200 Lines (seed:2)', () => {
  const env: EnvSetup = {
    cols: 80,
    rows: 24,
    cellHeight: 14,
    cellWidth: 7,
    scrollbackLines: 500,
    seed: 2,
  };

  it('validates coord maps incrementally for 200 chunks, then scroll', () => {
    const enriched = generateTestSequence(2, env, { numChunks: 200 });
    expect(enriched.chunks).toHaveLength(200);

    const adapter = new StubXtermAdapter();
    adapter.dimensions = { cols: 80, rows: 24, cellWidth: 7, cellHeight: 14, viewportPixelHeight: 336 };
    adapter.scrollState = { baseY: 0, viewportY: 0, cursorX: 0, cursorY: 0, bufferLength: 0 };

    const context = new ScrollContext(adapter);

    for (const ec of enriched.chunks) {
      const lineText = new TextDecoder().decode(ec.chunk.data);
      for (const coord of ec.expectedLines) {
        adapter.injectLine(coord.bufferRow, lineText.replace('\n', ''));
      }
      context.push(ec);

      for (const coord of ec.expectedLines) {
        const resolved = context.resolve({ lineNumber: coord.logicalLine });
        expect(resolved).not.toBeNull();
        expect(resolved!.lineNumber).toBe(coord.logicalLine);
        expect(resolved!.bufferIndex).toBe(coord.bufferRow);
      }
    }

    const totalBufferRows = adapter.bufferLength;
    const baseY = Math.max(0, totalBufferRows - env.rows);
    adapter.scrollState = {
      baseY,
      viewportY: 10,
      cursorX: 0,
      cursorY: 0,
      bufferLength: totalBufferRows,
    };

    const firstVisibleRow = baseY + 10;
    const lastVisibleRow = firstVisibleRow + env.rows - 1;

    const visible = context.getVisibleLines();
    for (const v of visible) {
      expect(v.bufferIndex).toBeGreaterThanOrEqual(firstVisibleRow);
      expect(v.bufferIndex).toBeLessThanOrEqual(lastVisibleRow);
      const expectedPixelY = (v.bufferIndex - firstVisibleRow) * env.cellHeight;
      expect(v.pixelY).toBe(expectedPixelY);
    }

    const report = validate(enriched, context);
    const tagFailures = report.results.filter(r =>
      r.failures.some(f => ['logicalLine', 'bufferRow', 'timestamp'].includes(f.field))
    );
    if (tagFailures.length > 0) {
      console.error('Tag field failures:', JSON.stringify(tagFailures, null, 2));
    }
    expect(tagFailures).toHaveLength(0);
    expect(report.totalChecked).toBe(200);
  });
});
