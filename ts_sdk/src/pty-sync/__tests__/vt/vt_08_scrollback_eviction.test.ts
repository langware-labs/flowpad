import { describe, it, expect } from 'vitest';
import { VirtualTerminal } from '../../simulator/VirtualTerminal.js';
import type { EnvSetup, OutputChunk } from '../../types.js';

// Small buffer: rows=3, scrollbackLines=5 → maxBufferRows=8
const env: EnvSetup = { cols: 80, rows: 3, cellHeight: 14, cellWidth: 7, scrollbackLines: 5, seed: 1 };

function chunk(seq: number, text: string): OutputChunk {
  return { seq, data: new TextEncoder().encode(text), timestamp: seq * 1000 };
}

describe('vt_08 — scrollback eviction', () => {
  it('writing 9 lines with maxBufferRows=8 evicts 1 row', () => {
    const vt = new VirtualTerminal(env);

    const results = [];
    for (let i = 1; i <= 9; i++) {
      const r = vt.processChunk(chunk(i, `Line${i}\n`));
      results.push(r);
    }

    const report = vt.getReport();
    // totalScrolledOff should be > 0
    expect(report.totalScrolledOff).toBeGreaterThan(0);

    // The first chunk's row 0 should be scrolled_off
    const firstResult = results[0];
    const row0 = firstResult.rows.find(r => r.bufferRow === 0);
    if (row0) {
      expect(row0.status).toBe('scrolled_off');
    }

    // Live buffer should have at most maxBufferRows entries
    expect(report.virtualBuffer.length).toBeLessThanOrEqual(8);
  });

  it('live buffer length never exceeds maxBufferRows', () => {
    const vt = new VirtualTerminal(env);
    for (let i = 1; i <= 50; i++) {
      vt.processChunk(chunk(i, `Line${i}\n`));
      const report = vt.getReport();
      expect(report.virtualBuffer.length).toBeLessThanOrEqual(8);
    }
  });
});
