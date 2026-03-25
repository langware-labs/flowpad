import { describe, it, expect } from 'vitest';
import { VirtualTerminal } from '../simulator/VirtualTerminal.js';
import type { EnvSetup, OutputChunk } from '../types.js';

const env: EnvSetup = { cols: 80, rows: 24, cellHeight: 14, cellWidth: 7, scrollbackLines: 200, seed: 9 };

function chunk(seq: number, text: string): OutputChunk {
  return { seq, data: new TextEncoder().encode(text), timestamp: seq * 1000 };
}

function makeTag(i: number, r = 0): string {
  const ll = String(i).padStart(4, '0');
  const rr = String(r).padStart(4, '0');
  return `{t:2024-01-01T00:00:00.000Z,l:${ll},r:${rr}}`;
}

describe('Test 9 — Mixed scenario types', () => {
  it('normal + ANSI + wide + tab + overwrite: all logicalLines unique', () => {
    const vt = new VirtualTerminal(env);
    let seq = 1;

    // 10 normal lines
    for (let i = 1; i <= 10; i++) {
      vt.processChunk(chunk(seq++, makeTag(i) + 'A'.repeat(37) + '\n'));
    }

    // 10 ANSI-colored lines
    for (let i = 11; i <= 20; i++) {
      vt.processChunk(chunk(seq++, `\x1b[31m${makeTag(i)}${'B'.repeat(37)}\x1b[0m\n`));
    }

    // 10 wide-char lines (tag + 19 CJK = 42+38=80 cols)
    for (let i = 21; i <= 30; i++) {
      vt.processChunk(chunk(seq++, makeTag(i) + '\u4e00'.repeat(19) + '\n'));
    }

    // 10 tab lines (tag + 1 tab)
    for (let i = 31; i <= 40; i++) {
      vt.processChunk(chunk(seq++, makeTag(i) + '\t\n'));
    }

    // 10 overwrite scenarios (1 draft + 1 commit each)
    for (let i = 41; i <= 50; i++) {
      vt.processChunk(chunk(seq++, 'DRAFT'.padEnd(52, '-') + '\r'));
      vt.processChunk(chunk(seq++, makeTag(i) + 'X'.repeat(37) + '\n'));
    }

    const report = vt.getReport();
    const logicalLines = report.virtualBuffer
      .filter(r => r.logicalLine !== null)
      .map(r => r.logicalLine!);

    const unique = new Set(logicalLines);
    expect(unique.size).toBe(logicalLines.length);
    expect(unique.size).toBe(50);
  });
});
