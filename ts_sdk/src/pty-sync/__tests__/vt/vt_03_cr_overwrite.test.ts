import { describe, it, expect } from 'vitest';
import { VirtualTerminal } from '../../simulator/VirtualTerminal.js';
import type { EnvSetup, OutputChunk } from '../../types.js';

const env: EnvSetup = { cols: 80, rows: 24, cellHeight: 14, cellWidth: 7, scrollbackLines: 100, seed: 1 };

function chunk(seq: number, text: string): OutputChunk {
  return { seq, data: new TextEncoder().encode(text), timestamp: seq * 1000 };
}

describe('vt_03 — \\r overwrite and ownership transfer', () => {
  it('two chunks overwriting the same row: first gets status=overwritten', () => {
    const vt = new VirtualTerminal(env);

    // Chunk 1: write draft content then \r (cursor goes back to col 0, no newline)
    const draft = 'DRAFT' + ' '.repeat(37); // 42 chars, not a valid tag
    const result1 = vt.processChunk(chunk(1, draft + '\r'));

    // Chunk 2: write a valid tag (overwriting chunk 1's content), then \n
    const tag = '{t:2024-01-01T00:00:00.000Z,l:0001,r:0000}';
    const result2 = vt.processChunk(chunk(2, tag + ' '.repeat(10) + '\n'));

    // After chunk 2, chunk 1's row 0 record should be overwritten
    const row0InResult1 = result1.rows.find(r => r.bufferRow === 0);
    expect(row0InResult1).toBeDefined();
    expect(row0InResult1!.status).toBe('overwritten');
    expect(row0InResult1!.overwrittenBySeq).toBe(2);

    // Chunk 2's row 0 record should be live with logicalLine=1
    const row0InResult2 = result2.rows.find(r => r.bufferRow === 0);
    expect(row0InResult2).toBeDefined();
    expect(row0InResult2!.status).toBe('live');
    expect(row0InResult2!.logicalLine).toBe(1);
  });

  it('\\r on same chunk does not trigger ownership transfer', () => {
    const vt = new VirtualTerminal(env);
    const tag = '{t:2024-01-01T00:00:00.000Z,l:0001,r:0000}';
    // Single chunk: write some chars, \r, then write tag, \n
    const text = 'AAAA\r' + tag + '\n';
    const result = vt.processChunk(chunk(1, text));

    const row0 = result.rows.find(r => r.bufferRow === 0);
    expect(row0).toBeDefined();
    expect(row0!.status).toBe('live');
    expect(row0!.logicalLine).toBe(1);
  });
});
