import { describe, it, expect } from 'vitest';
import { VirtualTerminal } from '../../simulator/VirtualTerminal.js';
import type { EnvSetup, OutputChunk } from '../../types.js';

const env: EnvSetup = { cols: 80, rows: 24, cellHeight: 14, cellWidth: 7, scrollbackLines: 100, seed: 1 };

function chunk(seq: number, text: string): OutputChunk {
  return { seq, data: new TextEncoder().encode(text), timestamp: seq * 1000 };
}

describe('vt_06 — tab expansion (8-col stops)', () => {
  it('tab at col=0 → cursor at col=8', () => {
    const vt = new VirtualTerminal(env);
    // Tab then 'A' then \n → A should be at col 8
    vt.processChunk(chunk(1, '\tA\n'));
    const report = vt.getReport();
    // Cols 0-7 are spaces, col 8 is 'A'
    const content = report.virtualBuffer[0].content;
    expect(content[0]).toBe(' ');
    expect(content[7]).toBe(' ');
    expect(content[8]).toBe('A');
  });

  it('tab at col=7 → cursor at col=8', () => {
    const vt = new VirtualTerminal(env);
    vt.processChunk(chunk(1, 'AAAAAAA\tB\n')); // 7 'A's then tab → B at col 8
    const report = vt.getReport();
    expect(report.virtualBuffer[0].content[8]).toBe('B');
  });

  it('tab at col=8 → cursor at col=16', () => {
    const vt = new VirtualTerminal(env);
    vt.processChunk(chunk(1, 'AAAAAAAA\tB\n')); // 8 'A's then tab → B at col 16
    const report = vt.getReport();
    expect(report.virtualBuffer[0].content[16]).toBe('B');
  });

  it('tab at col=72 → pendingWrap (tab would reach col=80)', () => {
    const vt = new VirtualTerminal(env);
    // 72 'A's fill cols 0-71, tab at col=72 → nextStop=80 → pendingWrap set
    // Then 'B' would wrap to next row
    vt.processChunk(chunk(1, 'A'.repeat(72) + '\tB\n'));
    const report = vt.getReport();
    // B should be at col 0 of row 1 (wrapped due to pendingWrap from tab)
    expect(report.virtualBuffer[1].isWrapped).toBe(true);
    expect(report.virtualBuffer[1].content[0]).toBe('B');
  });
});
