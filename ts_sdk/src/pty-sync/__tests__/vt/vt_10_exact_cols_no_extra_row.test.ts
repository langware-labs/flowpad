import { describe, it, expect } from 'vitest';
import { VirtualTerminal } from '../../simulator/VirtualTerminal.js';
import type { EnvSetup, OutputChunk } from '../../types.js';

const env: EnvSetup = { cols: 80, rows: 24, cellHeight: 14, cellWidth: 7, scrollbackLines: 100, seed: 1 };

function chunk(seq: number, text: string): OutputChunk {
  return { seq, data: new TextEncoder().encode(text), timestamp: seq * 1000 };
}

describe('vt_10 — exactly cols-wide line produces no extra wrap row', () => {
  it('80-char line at cols=80 produces exactly 1 content row then cursor on row 1', () => {
    const vt = new VirtualTerminal(env);
    const tag = '{t:2024-01-01T00:00:00.000Z,l:0001,r:0000}';
    const line = tag + 'X'.repeat(80 - 42) + '\n'; // exactly 80 visible chars

    const result = vt.processChunk(chunk(1, line));
    const report = vt.getReport();

    // Row 0 should have the tag, isWrapped=false
    expect(report.virtualBuffer[0].isWrapped).toBe(false);
    expect(report.virtualBuffer[0].logicalLine).toBe(1);

    // Row 1 should NOT be a wrap row (pendingWrap was cleared by \n)
    if (report.virtualBuffer[1]) {
      expect(report.virtualBuffer[1].isWrapped).toBe(false);
    }

    // The row record for bufferRow 0 should have logicalLine=1
    const row0 = result.rows.find(r => r.bufferRow === 0);
    expect(row0).toBeDefined();
    expect(row0!.logicalLine).toBe(1);
  });

  it('two consecutive 80-char lines → rows 0 and 1, neither wrapped', () => {
    const vt = new VirtualTerminal(env);
    const tag1 = '{t:2024-01-01T00:00:00.000Z,l:0001,r:0000}';
    const tag2 = '{t:2024-01-01T00:00:01.000Z,l:0002,r:0001}';
    const line1 = tag1 + 'X'.repeat(38) + '\n';
    const line2 = tag2 + 'Y'.repeat(38) + '\n';

    vt.processChunk(chunk(1, line1));
    vt.processChunk(chunk(2, line2));
    const report = vt.getReport();

    expect(report.virtualBuffer[0].isWrapped).toBe(false);
    expect(report.virtualBuffer[0].logicalLine).toBe(1);
    expect(report.virtualBuffer[1].isWrapped).toBe(false);
    expect(report.virtualBuffer[1].logicalLine).toBe(2);
  });
});
