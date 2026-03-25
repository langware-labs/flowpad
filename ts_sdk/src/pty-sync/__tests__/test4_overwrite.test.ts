import { describe, it, expect } from 'vitest';
import { VirtualTerminal } from '../simulator/VirtualTerminal.js';
import type { EnvSetup, OutputChunk } from '../types.js';

const env: EnvSetup = { cols: 80, rows: 24, cellHeight: 14, cellWidth: 7, scrollbackLines: 100, seed: 4 };

function chunk(seq: number, text: string): OutputChunk {
  return { seq, data: new TextEncoder().encode(text), timestamp: seq * 1000 };
}

describe('Test 4 — Overwrite (draft/commit)', () => {
  it('5 draft chunks + 1 commit: only commit row has valid tag; drafts overwritten', () => {
    const vt = new VirtualTerminal(env);
    const results = [];

    // 5 draft chunks: each writes filler content then \r (no newline)
    for (let i = 1; i <= 5; i++) {
      const draft = `Draft${i}`.padEnd(42, '-') + ' '.repeat(10) + '\r';
      results.push(vt.processChunk(chunk(i, draft)));
    }

    // Commit chunk: writes real tag + padding + \n
    const tag = '{t:2024-01-01T00:00:00.000Z,l:0001,r:0000}';
    const commit = tag + ' '.repeat(10) + '\n';
    const commitResult = vt.processChunk(chunk(6, commit));
    results.push(commitResult);

    // All draft results should have row 0 marked overwritten
    for (let i = 0; i < 5; i++) {
      const row0 = results[i].rows.find(r => r.bufferRow === 0);
      if (row0) {
        expect(row0.status).toBe('overwritten');
      }
    }

    // Commit result's row 0 should be live with logicalLine=1
    const commitRow0 = commitResult.rows.find(r => r.bufferRow === 0);
    expect(commitRow0).toBeDefined();
    expect(commitRow0!.status).toBe('live');
    expect(commitRow0!.logicalLine).toBe(1);

    // VirtualBuffer row 0 should have the tag
    const report = vt.getReport();
    expect(report.virtualBuffer[0].logicalLine).toBe(1);
    expect(report.virtualBuffer[0].content.slice(0, 42)).toBe(tag);
  });
});
