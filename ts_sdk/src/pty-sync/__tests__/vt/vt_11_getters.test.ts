import { describe, it, expect } from 'vitest';
import { VirtualTerminal } from '../../simulator/VirtualTerminal.js';
import type { EnvSetup, OutputChunk } from '../../types.js';

const env: EnvSetup = { cols: 80, rows: 24, cellHeight: 14, cellWidth: 7, scrollbackLines: 100, seed: 1 };

function chunk(seq: number, text: string): OutputChunk {
  return { seq, data: new TextEncoder().encode(text), timestamp: seq * 1000 };
}

describe('VirtualTerminal getters', () => {
  it('getCursorRow() matches getReport().finalCursorRow', () => {
    const vt = new VirtualTerminal(env);
    vt.processChunk(chunk(1, 'hello\nworld\n'));
    expect(vt.getCursorRow()).toBe(vt.getReport().finalCursorRow);
  });

  it('getTotalScrolledOff() matches getReport().totalScrolledOff', () => {
    const vt = new VirtualTerminal(env);
    vt.processChunk(chunk(1, 'hello\nworld\n'));
    expect(vt.getTotalScrolledOff()).toBe(vt.getReport().totalScrolledOff);
  });

  it('getCursorRow() is correct after scrollback eviction', () => {
    const smallEnv: EnvSetup = { cols: 80, rows: 3, cellHeight: 14, cellWidth: 7, scrollbackLines: 2, seed: 1 };
    const vt = new VirtualTerminal(smallEnv);
    // 10 lines: rows=3 + scrollback=2 = 5 max buffer. 10 lines -> 5 evicted.
    for (let i = 1; i <= 10; i++) {
      vt.processChunk(chunk(i, `line${i}\n`));
    }
    const report = vt.getReport();
    expect(vt.getCursorRow()).toBe(report.finalCursorRow);
    expect(vt.getTotalScrolledOff()).toBe(report.totalScrolledOff);
    expect(vt.getTotalScrolledOff()).toBeGreaterThan(0);
  });
});
