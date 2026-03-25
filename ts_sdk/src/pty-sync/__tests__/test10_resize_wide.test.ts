import { describe, it, expect } from 'vitest';
import { simulate } from '../simulator/TerminalSimulator.js';
import type { EnvSetup, OutputChunk } from '../types.js';

describe('Test 10 — Resize with wide chars', () => {
  it('CJK lines at cols=80 then cols=40: more wrap rows; logicalLines preserved', () => {
    // Generate some CJK-heavy chunks manually
    const env80: EnvSetup = { cols: 80, rows: 24, cellHeight: 14, cellWidth: 7, scrollbackLines: 500, seed: 10 };
    const encoder = new TextEncoder();

    // 20 lines: each has a tag (42 chars) + 19 CJK (38 cols) = 80 cols total
    // At cols=80: fits in 1 row (pendingWrap cleared by \n)
    // At cols=40: tag (42 cols, but 40 fits → wraps after 40) → 2+ rows per line
    const chunks: OutputChunk[] = [];
    for (let i = 1; i <= 20; i++) {
      const ll = String(i).padStart(4, '0');
      const r = String((i - 1) * 1).padStart(4, '0'); // will be recalculated
      const tag = `{t:2024-01-01T00:00:00.000Z,l:${ll},r:${r}}`;
      const line = tag + '\u4e00'.repeat(19) + '\n';
      chunks.push({ seq: i, data: encoder.encode(line), timestamp: i * 1000 });
    }

    // Simulate at cols=80
    const enriched80 = simulate(env80, chunks);
    const original = new Map<number, number>();
    for (const ec of enriched80.chunks) {
      for (const coord of ec.expectedLines) {
        original.set(coord.logicalLine, coord.bufferRow);
      }
    }

    // Simulate at cols=40
    const env40: EnvSetup = { ...env80, cols: 40 };
    const enriched40 = simulate(env40, chunks);
    const resized = new Map<number, number>();
    for (const ec of enriched40.chunks) {
      for (const coord of ec.expectedLines) {
        resized.set(coord.logicalLine, coord.bufferRow);
      }
    }

    // All 20 logical lines preserved
    expect(resized.size).toBe(20);
    for (const l of original.keys()) {
      expect(resized.has(l)).toBe(true);
    }

    // At cols=40, the 42-char tag alone wraps, so bufferRows must be >= cols=80 values
    let moreThan80 = 0;
    for (const [l, origRow] of original) {
      const newRow = resized.get(l)!;
      expect(newRow).toBeGreaterThanOrEqual(origRow);
      if (newRow > origRow) moreThan80++;
    }
    // All lines should have more rows at cols=40 (tag=42 chars > 40 cols)
    expect(moreThan80).toBeGreaterThan(0);
  });
});
