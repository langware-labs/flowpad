import { describe, it, expect } from 'vitest';
import { VirtualTerminal } from '../../simulator/VirtualTerminal.js';
import type { EnvSetup, OutputChunk } from '../../types.js';

const env: EnvSetup = { cols: 80, rows: 24, cellHeight: 14, cellWidth: 7, scrollbackLines: 100, seed: 1 };

function chunk(seq: number, text: string): OutputChunk {
  return { seq, data: new TextEncoder().encode(text), timestamp: seq * 1000 };
}

describe('vt_07 — multiline chunk', () => {
  it('2 \\n in one chunk → PacketSimResult.rows has entries for both lines', () => {
    const vt = new VirtualTerminal(env);
    const tag1 = '{t:2024-01-01T00:00:00.000Z,l:0001,r:0000}';
    const tag2 = '{t:2024-01-01T00:00:01.000Z,l:0002,r:0001}';
    const text = tag1 + '\n' + tag2 + '\n';

    const result = vt.processChunk(chunk(1, text));

    // Should have rows at bufferRow 0 and 1 at minimum (plus row 2 from last LF)
    const row0 = result.rows.find(r => r.bufferRow === 0);
    const row1 = result.rows.find(r => r.bufferRow === 1);
    expect(row0).toBeDefined();
    expect(row1).toBeDefined();
    expect(row0!.logicalLine).toBe(1);
    expect(row1!.logicalLine).toBe(2);
  });

  it('5 \\n in one chunk → 5 written rows', () => {
    const vt = new VirtualTerminal(env);
    let text = '';
    for (let i = 1; i <= 5; i++) {
      text += `Line${i}\n`;
    }
    const result = vt.processChunk(chunk(1, text));

    // At minimum rows 0-4 should appear
    for (let r = 0; r < 5; r++) {
      const row = result.rows.find(rec => rec.bufferRow === r);
      expect(row).toBeDefined();
    }
  });
});
