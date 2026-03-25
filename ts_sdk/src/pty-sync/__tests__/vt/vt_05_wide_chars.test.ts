import { describe, it, expect } from 'vitest';
import { VirtualTerminal } from '../../simulator/VirtualTerminal.js';
import type { EnvSetup, OutputChunk } from '../../types.js';

const env: EnvSetup = { cols: 80, rows: 24, cellHeight: 14, cellWidth: 7, scrollbackLines: 100, seed: 1 };

function chunk(seq: number, text: string): OutputChunk {
  return { seq, data: new TextEncoder().encode(text), timestamp: seq * 1000 };
}

describe('vt_05 — wide characters (CJK = 2 cols)', () => {
  it('40 CJK chars exactly fill 80-col row without wrapping', () => {
    const vt = new VirtualTerminal(env);
    // 40 CJK chars × 2 cols = 80 cols → fills row, pendingWrap set, \n clears it
    const cjk = '\u4e00'.repeat(40);
    vt.processChunk(chunk(1, cjk + '\n'));
    const report = vt.getReport();

    expect(report.virtualBuffer[0].isWrapped).toBe(false);
    // Row 1 from LF should not be wrapped
    expect(report.virtualBuffer[1]?.isWrapped).toBe(false);
  });

  it('41 CJK chars wrap to row 1 (80 cols used then 2 more needed)', () => {
    const vt = new VirtualTerminal(env);
    const cjk = '\u4e00'.repeat(41);
    vt.processChunk(chunk(1, cjk + '\n'));
    const report = vt.getReport();

    // Row 1 should be a wrap continuation
    expect(report.virtualBuffer[1].isWrapped).toBe(true);
  });

  it('CJK char at col 79 (1 space left) wraps before writing', () => {
    const vt = new VirtualTerminal(env);
    // 79 ASCII + 1 CJK (needs 2 cols but only 1 left) → CJK wraps to next row
    const line = 'A'.repeat(79) + '\u4e00' + '\n';
    vt.processChunk(chunk(1, line));
    const report = vt.getReport();

    expect(report.virtualBuffer[1].isWrapped).toBe(true);
    // CJK char should be at col 0 of row 1
    expect(report.virtualBuffer[1].content[0]).toBe('\u4e00');
  });
});
