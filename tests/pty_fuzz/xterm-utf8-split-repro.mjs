#!/usr/bin/env node
/**
 * Repro: xterm.js drops a 3-byte UTF-8 char when its bytes are split across
 * write(Uint8Array) calls with 2+ bytes of pending partial state.
 *
 * Reported upstream: https://github.com/xtermjs/xterm.js/issues/6003
 *
 * Setup:   npm i @xterm/headless
 * Run:     node xterm-utf8-split-repro.mjs
 * Result:  prints a PASS/FAIL table per split phase; exit code 0 = all pass,
 *          1 = at least one character was dropped.
 *
 * Expected (correct) behavior: every case prints "A<char>B".
 * Observed on @xterm/headless 6.0.0: the 3-byte cases split [2][1] and
 * [1][1][1] render "AB" — the character is silently dropped. 2-byte and
 * 4-byte characters survive every split phase; so does the [1][2] split.
 */
import pkg from '@xterm/headless';
const { Terminal } = pkg;

const writeAsync = (t, d) => new Promise((r) => t.write(d, r));

/** char, utf8 bytes, list of split phases (arrays of chunk lengths) */
const CASES = [
  ['é (2-byte C3 A9)', [0xc3, 0xa9], [[2], [1, 1]]],
  ['— (3-byte E2 80 94)', [0xe2, 0x80, 0x94], [[3], [1, 2], [2, 1], [1, 1, 1]]],
  ['🚀 (4-byte F0 9F 9A 80)', [0xf0, 0x9f, 0x9a, 0x80], [[4], [1, 3], [2, 2], [3, 1], [1, 1, 1, 1]]],
  // 4-byte char with 0x80 as 3rd byte: fails when the 0x80 lands in interim
  ['𐀀 (4-byte F0 90 80 80)', [0xf0, 0x90, 0x80, 0x80], [[4], [1, 3], [2, 2], [3, 1], [1, 1, 1, 1]]],
];

let failures = 0;
for (const [label, bytes, phases] of CASES) {
  const expected = `A${Buffer.from(bytes).toString('utf8')}B`;
  for (const phase of phases) {
    // allowProposedApi only for buffer inspection — the bug itself needs no proposed API
    const term = new Terminal({ cols: 20, rows: 2, allowProposedApi: true });
    await writeAsync(term, 'A');
    let off = 0;
    for (const n of phase) {
      await writeAsync(term, Uint8Array.from(bytes.slice(off, off + n)));
      off += n;
    }
    await writeAsync(term, 'B');
    const got = term.buffer.active.getLine(0).translateToString(true);
    const ok = got === expected;
    if (!ok) failures++;
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(26)} split [${phase.join('][')}]`.padEnd(60) +
        ` -> ${JSON.stringify(got)}${ok ? '' : `  (expected ${JSON.stringify(expected)})`}`,
    );
  }
}

console.log(failures === 0 ? '\nAll split phases OK.' : `\n${failures} split phase(s) dropped the character.`);
process.exit(failures === 0 ? 0 : 1);
