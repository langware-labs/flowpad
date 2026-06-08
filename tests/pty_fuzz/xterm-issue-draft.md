---
id: f0556960-20fc-5a1b-98ef-ad0ce43e00e4
---

# Title

UTF-8 input: codepoint silently dropped when `write(Uint8Array)` splits a sequence leaving a `0x80` continuation byte in interim state

# Body

## Bug description

When binary input is fed via `Terminal.write(Uint8Array)`, a multi-byte UTF-8 character is **silently dropped** if the bytes are split across `write()` calls such that the stashed partial (interim) bytes end with a continuation byte whose low 6 bits are zero (i.e. `0x80`).

Examples (em dash `—` = `E2 80 94`, U+10000 `𐀀` = `F0 90 80 80`):

```
write([0xE2, 0x80]); write([0x94])              → character LOST ("AB" instead of "A—B")
write([0xE2]); write([0x80]); write([0x94])     → character LOST
write([0xE2]); write([0x80, 0x94])              → OK
write([0xF0, 0x90, 0x80]); write([0x80])        → character LOST ("AB" instead of "A𐀀B")
write([0xF0, 0x90]); write([0x80, 0x80])        → OK
```

This is easy to hit in the real world: PTY reads chunk at arbitrary byte boundaries, and `E2 80 xx` covers extremely common characters — em/en dashes, `›`, `…`, curly quotes, and ZWJ (so emoji sequences like 🧑‍💻 lose their joiner and fall apart). We found it because replaying recorded terminal sessions through `@xterm/headless` occasionally lost em dashes depending on chunk alignment.

### Root cause

`src/common/input/TextDecoder.ts`, `Utf8ToUtf32.decode()`, in the leftover/interim handling at the top:

```ts
let pos = 0;
let tmp: number;
while ((tmp = this.interim[++pos] & 0x3F) && pos < 4) {
  cp <<= 6;
  cp |= tmp;
}
```

The loop counts how many continuation bytes were stashed in `interim`, but terminates on the **value** `this.interim[++pos] & 0x3F` being falsy. A legitimate continuation byte `0x80` has `0x80 & 0x3F === 0`, so the loop can't distinguish "stored continuation byte with zero payload bits" from "empty interim slot". It under-counts `pos`, so `missing = type - pos` over-counts; the decoder then consumes the actually-final continuation byte from the new chunk, still believes more bytes are missing, hits the end of input and `return 0` — emitting nothing and clearing the partial state. The codepoint is gone.

This explains the exact failure pattern: only splits that leave a `0x80` in `interim` fail; all other phases (including all splits of `é` and `🚀`, whose stashed continuation bytes have non-zero low bits) work. The line is unchanged since the original UTF-8 input implementation (#1904, 2019).

A fix would be to track the interim **count** explicitly (or zero-`interim` + index-based termination) instead of inferring it from byte-value truthiness.

## Details

- Browser and browser version: n/a (reproduces in Node with `@xterm/headless`; the decoder is shared `src/common` code, so DOM builds using the `Uint8Array` write path are equally affected)
- OS version: macOS 15 (Darwin 24.6.0), Node v22.15.0
- xterm.js version: `@xterm/headless` 6.0.0 (latest); the affected line is identical on current `master`

## Steps to reproduce

1. `npm i @xterm/headless`
2. Save the script below as `repro.mjs` and run `node repro.mjs`
3. Observe `FAIL` rows — expected output is `"A<char>B"` for every split phase; the failing phases print `"AB"` (character dropped). Exit code is 1 if any phase drops a character, 0 otherwise.

```js
import pkg from '@xterm/headless';
const { Terminal } = pkg;

const writeAsync = (t, d) => new Promise((r) => t.write(d, r));

/** char label, utf8 bytes, split phases (arrays of chunk lengths) */
const CASES = [
  ['é (2-byte C3 A9)', [0xc3, 0xa9], [[2], [1, 1]]],
  ['— (3-byte E2 80 94)', [0xe2, 0x80, 0x94], [[3], [1, 2], [2, 1], [1, 1, 1]]],
  ['🚀 (4-byte F0 9F 9A 80)', [0xf0, 0x9f, 0x9a, 0x80], [[4], [1, 3], [2, 2], [3, 1], [1, 1, 1, 1]]],
  ['𐀀 (4-byte F0 90 80 80)', [0xf0, 0x90, 0x80, 0x80], [[4], [1, 3], [2, 2], [3, 1], [1, 1, 1, 1]]],
];

let failures = 0;
for (const [label, bytes, phases] of CASES) {
  const expected = `A${Buffer.from(bytes).toString('utf8')}B`;
  for (const phase of phases) {
    // allowProposedApi only for buffer inspection — the bug needs no proposed API
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
      `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(26)} split [${phase.join('][')}]`.padEnd(62) +
        ` -> ${JSON.stringify(got)}${ok ? '' : `  (expected ${JSON.stringify(expected)})`}`,
    );
  }
}
console.log(failures === 0 ? '\nAll split phases OK.' : `\n${failures} split phase(s) dropped the character.`);
process.exit(failures === 0 ? 0 : 1);
```

Output on `@xterm/headless` 6.0.0:

```
PASS  é (2-byte C3 A9)           split [2]                    -> "AéB"
PASS  é (2-byte C3 A9)           split [1][1]                 -> "AéB"
PASS  — (3-byte E2 80 94)        split [3]                    -> "A—B"
PASS  — (3-byte E2 80 94)        split [1][2]                 -> "A—B"
FAIL  — (3-byte E2 80 94)        split [2][1]                 -> "AB"  (expected "A—B")
FAIL  — (3-byte E2 80 94)        split [1][1][1]              -> "AB"  (expected "A—B")
PASS  🚀 (4-byte F0 9F 9A 80)    split [4]                    -> "A🚀B"
PASS  🚀 (4-byte F0 9F 9A 80)    split [1][3]                 -> "A🚀B"
PASS  🚀 (4-byte F0 9F 9A 80)    split [2][2]                 -> "A🚀B"
PASS  🚀 (4-byte F0 9F 9A 80)    split [3][1]                 -> "A🚀B"
PASS  🚀 (4-byte F0 9F 9A 80)    split [1][1][1][1]           -> "A🚀B"
PASS  𐀀 (4-byte F0 90 80 80)    split [4]                    -> "A𐀀B"
PASS  𐀀 (4-byte F0 90 80 80)    split [1][3]                 -> "A𐀀B"
PASS  𐀀 (4-byte F0 90 80 80)    split [2][2]                 -> "A𐀀B"
FAIL  𐀀 (4-byte F0 90 80 80)    split [3][1]                 -> "AB"  (expected "A𐀀B")
FAIL  𐀀 (4-byte F0 90 80 80)    split [1][1][1][1]           -> "AB"  (expected "A𐀀B")

4 split phase(s) dropped the character.
```
