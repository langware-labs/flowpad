import { describe, it, expect } from 'vitest';
import { generateTestSequence } from '../generator/TestSequenceGenerator.js';
import { StubXtermAdapter } from '../adapter/XtermAdapter.js';
import { ScrollContext } from '../scroll/ScrollContext.js';
import { validate } from '../validator/Validator.js';
import type { EnvSetup } from '../types.js';

describe('Test 1 — Single Line (seed:1)', () => {
  const env: EnvSetup = {
    cols: 80,
    rows: 24,
    cellHeight: 14,
    cellWidth: 7,
    scrollbackLines: 100,
    seed: 1,
  };

  it('produces correct coords for a single 79-char line (no wrap)', () => {
    const enriched = generateTestSequence(1, env, {
      numChunks: 1,
      chunkLengths: [79], // 79 visible chars, no wrap (< 80 cols)
    });

    expect(enriched.chunks).toHaveLength(1);
    const ec = enriched.chunks[0];
    expect(ec.expectedLines).toHaveLength(1);

    const coord = ec.expectedLines[0];
    expect(coord.logicalLine).toBe(1);
    expect(coord.bufferRow).toBe(0);
    expect(coord.pixelY).toBe(0);

    const adapter = new StubXtermAdapter();
    adapter.dimensions = { cols: 80, rows: 24, cellWidth: 7, cellHeight: 14, viewportPixelHeight: 336 };
    adapter.scrollState = { baseY: 0, viewportY: 0, cursorX: 0, cursorY: 0, bufferLength: 1 };

    const lineText = new TextDecoder().decode(ec.chunk.data);
    adapter.injectLine(0, lineText.replace('\n', ''));

    const context = new ScrollContext(adapter);
    context.push(ec);

    const resolved = context.resolve({ lineNumber: 1 });
    expect(resolved).not.toBeNull();
    expect(resolved!.lineNumber).toBe(1);
    expect(resolved!.bufferIndex).toBe(0);
    expect(resolved!.pixelY).toBe(0);

    const visible = context.getVisibleLines();
    expect(visible).toHaveLength(1);
    expect(visible[0].lineNumber).toBe(1);

    const report = validate(enriched, context);
    if (report.totalPassed !== report.totalChecked) {
      console.error('Validation failures:', JSON.stringify(report.results.filter(r => !r.pass), null, 2));
    }
    expect(report.totalPassed).toBe(report.totalChecked);
    expect(report.totalChecked).toBe(1);
  });
});
