import { describe, it, expect } from 'vitest';
import { VirtualTerminal } from '../../simulator/VirtualTerminal.js';
import type { EnvSetup, OutputChunk } from '../../types.js';

const env: EnvSetup = { cols: 80, rows: 24, cellHeight: 14, cellWidth: 7, scrollbackLines: 100, seed: 1 };

function chunk(seq: number, text: string): OutputChunk {
  return { seq, data: new TextEncoder().encode(text), timestamp: seq * 1000 };
}

describe('vt_09 — CSI cursor movement', () => {
  it('\\x1b[5;1H moves cursor to row 4, col 0 (0-based)', () => {
    const vt = new VirtualTerminal(env);
    // Move cursor to row 5;col 1 (1-based) then write 'X'
    vt.processChunk(chunk(1, '\x1b[5;1HX\n'));
    const report = vt.getReport();

    // Row 4 (0-based) should have 'X' at col 0
    expect(report.virtualBuffer[4]).toBeDefined();
    expect(report.virtualBuffer[4].content[0]).toBe('X');
  });

  it('cursor up (\\x1b[2A) moves up 2 rows', () => {
    const vt = new VirtualTerminal(env);
    // Write 3 lines, then move up 2, write 'X'
    vt.processChunk(chunk(1, 'Line1\nLine2\nLine3\n\x1b[2AX'));
    const report = vt.getReport();

    // After 3 LFs cursor is at row 3 (live). Up 2 → row 1.
    expect(report.virtualBuffer[1].content[0]).toBe('X');
  });

  it('cursor right (\\x1b[5C) and left (\\x1b[3D)', () => {
    const vt = new VirtualTerminal(env);
    vt.processChunk(chunk(1, '\x1b[5CX\x1b[3DY\n'));
    const report = vt.getReport();

    // Cursor starts at col 0, right 5 → col 5, write X
    // Left 3 → col 3 (from col 6 after X), write Y
    expect(report.virtualBuffer[0].content[5]).toBe('X');
    expect(report.virtualBuffer[0].content[3]).toBe('Y');
  });
});
