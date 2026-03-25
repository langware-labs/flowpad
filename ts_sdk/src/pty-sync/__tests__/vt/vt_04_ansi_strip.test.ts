import { describe, it, expect } from 'vitest';
import { VirtualTerminal } from '../../simulator/VirtualTerminal.js';
import type { EnvSetup, OutputChunk } from '../../types.js';

const env: EnvSetup = { cols: 80, rows: 24, cellHeight: 14, cellWidth: 7, scrollbackLines: 100, seed: 1 };

function chunk(seq: number, text: string): OutputChunk {
  return { seq, data: new TextEncoder().encode(text), timestamp: seq * 1000 };
}

describe('vt_04 — ANSI escape stripping', () => {
  it('ANSI color codes do not count as columns (no phantom wraps)', () => {
    const vt = new VirtualTerminal(env);
    // 79 visible chars wrapped in \x1b[31m...\x1b[0m — still fits in 80 cols
    const tag = '{t:2024-01-01T00:00:00.000Z,l:0001,r:0000}';
    const padding = ' '.repeat(79 - 42);
    const line = `\x1b[31m${tag}${padding}\x1b[0m\n`;

    vt.processChunk(chunk(1, line));
    const report = vt.getReport();

    // Should be on exactly 1 row (no wrap despite ANSI bytes inflating byte count)
    expect(report.virtualBuffer.length).toBeGreaterThanOrEqual(1);
    expect(report.virtualBuffer[0].isWrapped).toBe(false);

    // Content should have no ANSI bytes — just the visible chars
    expect(report.virtualBuffer[0].content).not.toContain('\x1b');
    expect(report.virtualBuffer[0].logicalLine).toBe(1);
  });

  it('79-char line with heavy ANSI stays on 1 row', () => {
    const vt = new VirtualTerminal(env);
    // Each visible char wrapped in its own ANSI code
    let line = '';
    for (let i = 0; i < 79; i++) {
      line += `\x1b[3${(i % 7) + 1}mA\x1b[0m`;
    }
    line += '\n';

    vt.processChunk(chunk(1, line));
    const report = vt.getReport();

    // Row 0 content should be 79 'A's
    expect(report.virtualBuffer[0].content.trimEnd()).toBe('A'.repeat(79));
    expect(report.virtualBuffer[0].isWrapped).toBe(false);
  });
});
