import { describe, it, expect } from 'vitest';
import { VirtualTerminal } from '../simulator/VirtualTerminal.js';
import type { EnvSetup, OutputChunk } from '../types.js';

const env: EnvSetup = { cols: 80, rows: 24, cellHeight: 14, cellWidth: 7, scrollbackLines: 200, seed: 7 };

function chunk(seq: number, text: string): OutputChunk {
  return { seq, data: new TextEncoder().encode(text), timestamp: seq * 1000 };
}

describe('Test 7 — Multiline chunks', () => {
  it('chunks with 2–5 logical lines: PacketSimResult.rows counts match', () => {
    const vt = new VirtualTerminal(env);
    let lineCounter = 1;

    for (let numLines = 2; numLines <= 5; numLines++) {
      let text = '';
      for (let ln = 0; ln < numLines; ln++) {
        const ll = String(lineCounter++).padStart(4, '0');
        text += `{t:2024-01-01T00:00:00.000Z,l:${ll},r:0000}padding\n`;
      }
      const result = vt.processChunk(chunk(numLines - 1, text));

      // Each \n produces an LF row; each tag-bearing row should appear
      // At minimum numLines rows should have logicalLine set
      const taggedInResult = result.rows.filter(r => r.logicalLine !== null);
      expect(taggedInResult.length).toBeGreaterThanOrEqual(numLines);
    }
  });

  it('single chunk with 5 \n: 5 tag rows in result', () => {
    const vt = new VirtualTerminal(env);
    let text = '';
    for (let i = 1; i <= 5; i++) {
      const ll = String(i).padStart(4, '0');
      text += `{t:2024-01-01T00:00:00.000Z,l:${ll},r:0000}pad\n`;
    }
    const result = vt.processChunk(chunk(1, text));
    const tagged = result.rows.filter(r => r.logicalLine !== null);
    expect(tagged).toHaveLength(5);
  });
});
