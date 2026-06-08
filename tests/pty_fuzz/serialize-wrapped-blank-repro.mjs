#!/usr/bin/env node
/**
 * Repro: SerializeAddon loses the LEADING blank cells of a wrapped row
 * (plus one adjacent cell at exact-fit boundaries) on serialize -> restore.
 *
 * The degenerate rows arise from a realistic sequence: a long soft-wrapped
 * line is being written when the terminal is resized (grow), the rest of the
 * line lands at the new width, then the terminal shrinks — reflow leaves a
 * blank gap region inside the wrapped line. The live buffer is correct;
 * SerializeAddon's output drops the gap row's leading blanks, so the
 * restored terminal differs from the terminal it was serialized from.
 *
 * Setup:   npm i @xterm/headless @xterm/addon-serialize
 * Run:     node serialize-wrapped-blank-repro.mjs
 * Exit:    0 = round-trip faithful for every tested split point,
 *          1 = at least one divergence (prints the first diff).
 *
 * Observed on @xterm/headless 6.0.0 + @xterm/addon-serialize 0.14.0.
 */
import pkgH from '@xterm/headless';
import pkgS from '@xterm/addon-serialize';

const { Terminal } = pkgH;
const SerializeAddon = pkgS.SerializeAddon ?? pkgS.default?.SerializeAddon;

const writeAsync = (t, d) => new Promise((r) => t.write(d, r));

// One 840-char line of 7-char tokens: L2-001.L2-002. ... L2-120.
const longLine = (tag) =>
  Array.from({ length: 120 }, (_, i) => `${tag}-${String(i + 1).padStart(3, '0')}.`).join('');

function bufferLines(term) {
  const buf = term.buffer.active;
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    out.push(buf.getLine(i)?.translateToString(true) ?? '');
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

/** Build the state: write at 100 cols, grow to 140 mid-line-2, finish, shrink to 80. */
async function buildTerminal(splitAt) {
  const term = new Terminal({ cols: 100, rows: 30, scrollback: 1000, allowProposedApi: true });
  const addon = new SerializeAddon();
  term.loadAddon(addon);

  const l1 = longLine('L1');
  const l2 = longLine('L2');
  const l3 = longLine('L3');

  await writeAsync(term, l1 + '\r\n' + l2.slice(0, splitAt));
  term.resize(140, 50); // grow mid-soft-wrapped-line -> reflow gap
  await writeAsync(term, l2.slice(splitAt) + '\r\n' + l3 + '\r\n');
  term.resize(80, 24); // shrink -> re-reflow
  return { term, addon };
}

let firstFailure = null;
let tested = 0;
for (let splitAt = 0; splitAt <= 840; splitAt += 28) {
  tested++;
  const { term, addon } = await buildTerminal(splitAt);
  const serialized = addon.serialize({ scrollback: 1000 });

  const restored = new Terminal({ cols: 80, rows: 24, scrollback: 1000, allowProposedApi: true });
  await writeAsync(restored, serialized);

  const src = bufferLines(term);
  const dst = bufferLines(restored);
  const equal = src.length === dst.length && src.every((l, i) => l === dst[i]);
  if (!equal && !firstFailure) {
    firstFailure = { splitAt, src, dst };
  }
  term.dispose();
  restored.dispose();
}

if (!firstFailure) {
  console.log(`PASS: ${tested} split points round-trip faithfully.`);
  process.exit(0);
}

const { splitAt, src, dst } = firstFailure;
console.log(`FAIL at splitAt=${splitAt}: source buffer has ${src.length} rows, restored has ${dst.length}.`);
for (let i = 0; i < Math.max(src.length, dst.length); i++) {
  if (src[i] !== dst[i]) {
    console.log(`first differing row ${i}:`);
    console.log(`  source   : ${JSON.stringify(src[i] ?? '<none>')}`);
    console.log(`  restored : ${JSON.stringify(dst[i] ?? '<none>')}`);
    break;
  }
}
console.log(
  '\nThe serialized output dropped the leading blank cells of a wrapped row' +
    '\n(reflow gap), shifting the rest of the logical line.',
);
process.exit(1);
