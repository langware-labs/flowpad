import { describe, it, expect } from 'vitest';
import { VirtualTerminal } from '../simulator/VirtualTerminal.js';
import type { EnvSetup, OutputChunk } from '../types.js';

const env: EnvSetup = { cols: 80, rows: 24, cellHeight: 14, cellWidth: 7, scrollbackLines: 500, seed: 5 };

function chunk(seq: number, text: string): OutputChunk {
  return { seq, data: new TextEncoder().encode(text), timestamp: seq * 1000 };
}

describe('Test 5 — ANSI colors: no phantom wraps', () => {
  it('50 colored lines: no phantom wraps, VirtualRow.content has no ANSI bytes', () => {
    const vt = new VirtualTerminal(env);

    for (let i = 1; i <= 50; i++) {
      const tag = `{t:2024-01-0${i <= 9 ? '1' : '2'}T00:00:${String(i % 60).padStart(2,'0')}.000Z,l:${String(i).padStart(4,'0')},r:0000}`;
      // Wrap in ANSI color: 79 visible chars total, heavily ANSI-colored
      const visible = tag.slice(0, 42) + `${'A'.repeat(37)}`;
      const colored = `\x1b[3${(i % 7) + 1}m${visible}\x1b[0m\n`;
      vt.processChunk(chunk(i, colored));
    }

    const report = vt.getReport();

    // Check first 50 live rows
    let taggedRows = 0;
    for (const row of report.virtualBuffer) {
      // No ANSI escape sequences in content
      expect(row.content).not.toContain('\x1b');
      if (row.logicalLine !== null) taggedRows++;
    }

    // All 50 lines should have been detected (no phantom wraps inflating row count)
    expect(taggedRows).toBe(50);
  });

  it('79-char colored line stays on 1 row despite ANSI byte count', () => {
    const vt = new VirtualTerminal(env);
    // This would fail with a byte-counter: \x1b[31m = 5 extra bytes
    const visible = 'A'.repeat(79);
    vt.processChunk(chunk(1, `\x1b[31m${visible}\x1b[0m\n`));
    const report = vt.getReport();

    expect(report.virtualBuffer[0].isWrapped).toBe(false);
    expect(report.virtualBuffer[0].content.trimEnd()).toBe('A'.repeat(79));
  });
});
