import { describe, it, expect } from 'vitest';
import { VirtualTerminal } from '../../simulator/VirtualTerminal.js';
import type { EnvSetup, OutputChunk } from '../../types.js';

const env: EnvSetup = { cols: 80, rows: 24, cellHeight: 14, cellWidth: 7, scrollbackLines: 100, seed: 1 };

function chunk(seq: number, text: string): OutputChunk {
  return { seq, data: new TextEncoder().encode(text), timestamp: seq * 1000 };
}

describe('vt_02 — pending wrap', () => {
  it('80 chars + \\n → exactly 1 buffer row written (no extra wrap row)', () => {
    const vt = new VirtualTerminal(env);
    // 80 visible chars fills the row, pendingWrap is set, then \n clears it without adding a row
    const line = 'A'.repeat(80) + '\n';
    const result = vt.processChunk(chunk(1, line));

    // Only row 0 should be seen as a written row (plus row 1 from LF)
    const writtenRows = result.rows.filter(r => r.bufferRow === 0);
    expect(writtenRows).toHaveLength(1);
    // Row 1 appears in seenAbsRows due to LF (cursor moved there)
    // Row 0 content should be 80 'A' chars
    const report = vt.getReport();
    const row0Content = report.virtualBuffer[0].content.trimEnd();
    expect(row0Content).toBe('A'.repeat(80));
  });

  it('81 chars + \\n → 2 buffer rows', () => {
    const vt = new VirtualTerminal(env);
    // 80 chars fills row 0 → pendingWrap. 81st char wraps to row 1.
    const line = 'A'.repeat(81) + '\n';
    vt.processChunk(chunk(1, line));

    const report = vt.getReport();
    // Row 1 should be wrapped
    expect(report.virtualBuffer[1].isWrapped).toBe(true);
    // Row 1 content should have the 81st char
    expect(report.virtualBuffer[1].content[0]).toBe('A');
  });

  it('exactly 80 chars + \\n does NOT produce an extra empty wrap row before row 1', () => {
    const vt = new VirtualTerminal(env);
    const line = 'A'.repeat(80) + '\n' + 'B'.repeat(5) + '\n';
    vt.processChunk(chunk(1, line));

    const report = vt.getReport();
    // Row 0: 80 'A's (not wrapped, pendingWrap cleared by \n)
    // Row 1: 5 'B's
    expect(report.virtualBuffer[0].isWrapped).toBe(false);
    expect(report.virtualBuffer[1].isWrapped).toBe(false);
    expect(report.virtualBuffer[1].content.trimEnd()).toBe('BBBBB');
  });
});
