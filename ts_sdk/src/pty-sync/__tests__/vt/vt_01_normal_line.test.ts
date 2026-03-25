import { describe, it, expect } from 'vitest';
import { VirtualTerminal } from '../../simulator/VirtualTerminal.js';
import type { EnvSetup, OutputChunk } from '../../types.js';

const env: EnvSetup = { cols: 80, rows: 24, cellHeight: 14, cellWidth: 7, scrollbackLines: 100, seed: 1 };

function chunk(seq: number, text: string): OutputChunk {
  return { seq, data: new TextEncoder().encode(text), timestamp: seq * 1000 };
}

describe('vt_01 — normal line', () => {
  it('79 chars + \\n → 1 row, logicalLine from tag, isWrapped=false', () => {
    const vt = new VirtualTerminal(env);
    const tag = '{t:2024-01-01T00:00:00.000Z,l:0001,r:0000}';
    const line = tag + ' '.repeat(79 - 42) + '\n'; // 79 visible chars + \n

    const result = vt.processChunk(chunk(1, line));
    const report = vt.getReport();

    expect(result.rows).toHaveLength(1); // only row 0 (written); LF destination has ownerSeq=null
    const row0 = result.rows.find(r => r.bufferRow === 0);
    expect(row0).toBeDefined();
    expect(row0!.logicalLine).toBe(1);
    expect(row0!.status).toBe('live');

    const vRow = report.virtualBuffer[0];
    expect(vRow.isWrapped).toBe(false);
    expect(vRow.logicalLine).toBe(1);
    expect(vRow.content.slice(0, 42)).toBe(tag);
  });
});
