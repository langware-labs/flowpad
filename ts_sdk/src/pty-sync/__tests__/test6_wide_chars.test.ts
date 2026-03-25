import { describe, it, expect } from 'vitest';
import { VirtualTerminal } from '../simulator/VirtualTerminal.js';
import type { EnvSetup, OutputChunk } from '../types.js';

const env: EnvSetup = { cols: 80, rows: 24, cellHeight: 14, cellWidth: 7, scrollbackLines: 200, seed: 6 };

function chunk(seq: number, text: string): OutputChunk {
  return { seq, data: new TextEncoder().encode(text), timestamp: seq * 1000 };
}

describe('Test 6 — Wide chars: correct bufferRow accounting', () => {
  it('20 lines mixing ASCII + CJK: bufferRows are monotonically increasing', () => {
    const vt = new VirtualTerminal(env);
    const taggedRows: Array<{ logicalLine: number; bufferRow: number }> = [];

    for (let i = 1; i <= 20; i++) {
      const ll = String(i).padStart(4, '0');
      // Mix: 20 ASCII + 20 CJK (20*2=40 cols) + tag at start = 42 + rest
      // Keep total under 80 cols to avoid wrap on even lines, let odd lines wrap
      let line: string;
      if (i % 2 === 0) {
        // Even: tag (42) + 18 ASCII = 60 cols → no wrap
        const tag = `{t:2024-01-01T00:00:00.000Z,l:${ll},r:0000}`;
        line = tag + 'A'.repeat(18) + '\n';
      } else {
        // Odd: tag (42) + 19 CJK (38 cols) = 80 cols → pendingWrap cleared by \n
        const tag = `{t:2024-01-01T00:00:00.000Z,l:${ll},r:0000}`;
        line = tag + '\u4e00'.repeat(19) + '\n';
      }
      vt.processChunk(chunk(i, line));
    }

    const report = vt.getReport();
    for (const row of report.virtualBuffer) {
      if (row.logicalLine !== null) {
        taggedRows.push({ logicalLine: row.logicalLine, bufferRow: report.totalScrolledOff + report.virtualBuffer.indexOf(row) });
      }
    }

    // bufferRows should be monotonically non-decreasing as logicalLine increases
    for (let i = 1; i < taggedRows.length; i++) {
      expect(taggedRows[i].bufferRow).toBeGreaterThanOrEqual(taggedRows[i-1].bufferRow);
    }

    expect(taggedRows).toHaveLength(20);
  });
});
