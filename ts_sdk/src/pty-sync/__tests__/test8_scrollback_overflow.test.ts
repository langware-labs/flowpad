import { describe, it, expect } from 'vitest';
import { VirtualTerminal } from '../simulator/VirtualTerminal.js';
import type { EnvSetup, OutputChunk } from '../types.js';

// rows=24, scrollbackLines=50 → maxBufferRows=74
const env: EnvSetup = { cols: 80, rows: 24, cellHeight: 14, cellWidth: 7, scrollbackLines: 50, seed: 8 };

function chunk(seq: number, text: string): OutputChunk {
  return { seq, data: new TextEncoder().encode(text), timestamp: seq * 1000 };
}

describe('Test 8 — Scrollback overflow (200 lines)', () => {
  it('after 200 lines: live buffer ≤ maxBufferRows, early packets scrolled_off', () => {
    const vt = new VirtualTerminal(env);
    const results = [];

    for (let i = 1; i <= 200; i++) {
      const ll = String(i).padStart(4, '0');
      const text = `{t:2024-01-01T00:00:00.000Z,l:${ll},r:0000}X\n`;
      results.push(vt.processChunk(chunk(i, text)));
    }

    const report = vt.getReport();
    expect(report.totalScrolledOff).toBeGreaterThan(0);
    expect(report.virtualBuffer.length).toBeLessThanOrEqual(74); // maxBufferRows

    // Early packets (first ~126) should have at least some scrolled_off rows
    let scrolledOffCount = 0;
    for (const result of results) {
      for (const row of result.rows) {
        if (row.status === 'scrolled_off') scrolledOffCount++;
      }
    }
    expect(scrolledOffCount).toBeGreaterThan(0);
  });

  it('all logical lines are unique in the final virtual buffer', () => {
    const vt = new VirtualTerminal(env);
    for (let i = 1; i <= 200; i++) {
      const ll = String(i).padStart(4, '0');
      const text = `{t:2024-01-01T00:00:00.000Z,l:${ll},r:0000}X\n`;
      vt.processChunk(chunk(i, text));
    }

    const report = vt.getReport();
    const logicalLines = report.virtualBuffer
      .filter(r => r.logicalLine !== null)
      .map(r => r.logicalLine!);

    const unique = new Set(logicalLines);
    expect(unique.size).toBe(logicalLines.length);
  });
});
