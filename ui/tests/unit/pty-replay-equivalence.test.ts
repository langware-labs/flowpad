/**
 * PTY replay theory validation — NO production code involved.
 *
 * Fixtures: tests/fixtures/pty-fuzz/*.json — real PTY recordings of the bash
 * fuzz strategies (tests/pty_fuzz/strategies.sh) with resize events recorded
 * at their byte offsets (tests/pty_fuzz/record_streams.py).
 *
 * H1 (the fix): feeding the recording into a fresh headless xterm, honoring
 *    recorded resizes — under ANY chunk-split schedule — then serializing and
 *    restoring into another fresh terminal, reproduces exactly what a
 *    continuously-attached terminal shows.
 *
 * H2 (the premise): naively replaying the same bytes at a different fixed
 *    size (ignoring resize events) diverges — the garble that got the old
 *    PtyReplayBuffer removed.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Terminal } from '@xterm/headless';

const FIXTURES_DIR = join(__dirname, '..', 'fixtures', 'pty-fuzz');

interface Fixture {
  cols: number;
  rows: number;
  strategy: string;
  schedule: string;
  events: Array<['o', string] | ['r', [number, number]]>;
}

// ---------------------------------------------------------------------------
// helpers

function newTerm(cols: number, rows: number): Terminal {
  return new Terminal({ cols, rows, scrollback: 50000, allowProposedApi: true });
}

function writeAsync(term: Terminal, data: Uint8Array | string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

function b64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}

/** Full observable state: every buffer line (scrollback + viewport) + cursor. */
function snapshot(term: Terminal) {
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    lines.push(buf.getLine(i)?.translateToString(true) ?? '');
  }
  // trim trailing blank lines — terminals at different row counts pad differently
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return {
    lines,
    cursorAbs: buf.baseY + buf.cursorY,
    cursorX: buf.cursorX,
    cols: term.cols,
    rows: term.rows,
    bufferType: buf.type,
  };
}

// Chunk-split schedules — how the recorded byte stream is cut when fed to the
// replayer. Splits must never change interpretation.
type Splitter = (data: Uint8Array) => Uint8Array[];

const SPLITTERS: Record<string, Splitter> = {
  whole: (d) => [d],
  'pty-natural': (d) => [d], // fixture chunks ARE the natural reads; identity per-event
  bytes7: (d) => {
    const out: Uint8Array[] = [];
    for (let i = 0; i < d.length; i += 7) out.push(d.subarray(i, i + 7));
    return out;
  },
  'mid-escape': (d) => {
    // split immediately AFTER every ESC byte → parser always resumes mid-sequence
    const out: Uint8Array[] = [];
    let start = 0;
    for (let i = 0; i < d.length; i++) {
      if (d[i] === 0x1b) {
        out.push(d.subarray(start, i + 1));
        start = i + 1;
      }
    }
    if (start < d.length) out.push(d.subarray(start));
    return out.filter((c) => c.length > 0);
  },
  'mid-utf8': (d) => {
    // split immediately AFTER every UTF-8 lead byte → multi-byte chars cut open
    const out: Uint8Array[] = [];
    let start = 0;
    for (let i = 0; i < d.length; i++) {
      if (d[i] >= 0xc0) {
        out.push(d.subarray(start, i + 1));
        start = i + 1;
      }
    }
    if (start < d.length) out.push(d.subarray(start));
    return out.filter((c) => c.length > 0);
  },
  'seeded-random': (d) => {
    // xorshift32, fixed seed — reproducible
    let s = 0x9e3779b9;
    const rnd = () => {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      return (s >>> 0) / 0xffffffff;
    };
    const out: Uint8Array[] = [];
    let start = 0;
    while (start < d.length) {
      const n = 1 + Math.floor(rnd() * 23);
      out.push(d.subarray(start, start + n));
      start += n;
    }
    return out;
  },
};

/** Feed a recording into a terminal: honor resize events, split output per schedule.
 *
 * Bytes are decoded to strings with a STREAMING TextDecoder before writing —
 * exactly what the live path does (ptyConnection.appendOutput). This matters:
 * xterm.js's own Uint8Array input path DROPS a multi-byte UTF-8 char when a
 * split leaves a 0x80 continuation byte in the decoder's interim state
 * ([E2 80][94] -> em-dash lost; found by this matrix on real Claude streams;
 * reported upstream: https://github.com/xtermjs/xterm.js/issues/6003).
 * A streaming TextDecoder handles every split phase, so a replayer must use
 * the same decode-to-string discipline as live.
 *
 * Writes are queued without per-chunk awaits (xterm's write queue preserves
 * order); we only flush before a resize — the same discipline a production
 * replayer needs — and at the end. Awaiting every chunk cost ~21k microtask
 * round-trips on the burst fixtures and tripped the 5s test cap.
 */
async function feed(term: Terminal, fx: Fixture, splitter: Splitter): Promise<void> {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let flush: Promise<void> = Promise.resolve();
  for (const ev of fx.events) {
    if (ev[0] === 'o') {
      for (const chunk of splitter(b64ToBytes(ev[1]))) {
        flush = writeAsync(term, decoder.decode(chunk, { stream: true }));
      }
    } else {
      await flush; // resize must not overtake queued output
      term.resize(ev[1][0], ev[1][1]);
    }
  }
  await flush;
}

function totalBytes(fx: Fixture): number {
  return fx.events.reduce((n, ev) => (ev[0] === 'o' ? n + Buffer.from(ev[1], 'base64').length : n), 0);
}

function finalSize(fx: Fixture): [number, number] {
  let size: [number, number] = [fx.cols, fx.rows];
  for (const ev of fx.events) if (ev[0] === 'r') size = ev[1];
  return size;
}

// ---------------------------------------------------------------------------

const available = existsSync(FIXTURES_DIR)
  ? readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.json') && f !== 'manifest.json')
  : [];

describe.skipIf(available.length === 0)('PTY replay equivalence matrix', () => {
  if (available.length === 0) {
    console.warn(
      'pty-fuzz fixtures missing — generate with: uv run python -m tests.pty_fuzz.record_streams --out ui/tests/fixtures/pty-fuzz',
    );
  }

  for (const file of available) {
    const fx: Fixture = JSON.parse(readFileSync(join(FIXTURES_DIR, file), 'utf8'));

    describe(`${fx.strategy} / resize:${fx.schedule}`, () => {
      // Reference: what a continuously-attached terminal saw.
      async function reference() {
        const term = newTerm(fx.cols, fx.rows);
        await feed(term, fx, SPLITTERS.whole);
        return term;
      }

      for (const [splitName, splitter] of Object.entries(SPLITTERS)) {
        it(`H1 replay split:${splitName} ≡ reference`, async () => {
          const ref = await reference();
          const replayed = newTerm(fx.cols, fx.rows);
          await feed(replayed, fx, splitter);

          expect(snapshot(replayed)).toEqual(snapshot(ref));
        });
      }

      it('H1 serialize→restore ≡ reference', async () => {
        const ref = await reference();

        // Production-faithful path: replay the RECORDED chunk boundaries.
        const replayed = newTerm(fx.cols, fx.rows);
        const addon = new SerializeAddon();
        replayed.loadAddon(addon);
        await feed(replayed, fx, SPLITTERS['pty-natural']);

        const serialized = addon.serialize({ scrollback: 50000 });

        const [fcols, frows] = finalSize(fx);
        const restored = newTerm(fcols, frows);
        await writeAsync(restored, serialized);

        const refSnap = snapshot(ref);
        const restoredSnap = snapshot(restored);
        expect(restoredSnap.lines).toEqual(refSnap.lines);
        expect([restoredSnap.cursorAbs, restoredSnap.cursorX]).toEqual([
          refSnap.cursorAbs,
          refSnap.cursorX,
        ]);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// H2 — the premise: naive replay at a different size garbles.

// Run 1 finding: xterm reflow makes end-states CONVERGE when the naive width
// equals the recording's final width (reflow-to-W ≡ written-at-W) — so the
// naive size must differ from the FINAL recorded size, and the content must
// actually exercise the width (burst's 60-col lines never wrap anywhere,
// which is why it was dropped from this list).
const WIDTH_SENSITIVE = ['erase_repaint', 'long_wrap', 'cr_overwrite', 'wide_utf8'];

describe.skipIf(available.length === 0)('H2 negative control: naive replay diverges', () => {
  const cases = available.filter((f) => WIDTH_SENSITIVE.some((s) => f.startsWith(`${s}__`)));

  for (const file of cases) {
    const fx: Fixture = JSON.parse(readFileSync(join(FIXTURES_DIR, file), 'utf8'));
    const [fcols, frows] = finalSize(fx);
    // pick a naive size different from the recording's final size
    const [ncols, nrows] = fcols === 80 && frows === 24 ? [64, 18] : [80, 24];

    it(`${fx.strategy} / resize:${fx.schedule} — naive ${ncols}x${nrows} replay ≠ reference`, async () => {
      const ref = newTerm(fx.cols, fx.rows);
      await feed(ref, fx, SPLITTERS.whole);

      // The old PtyReplayBuffer failure mode: all bytes, client's CURRENT
      // size, resize events ignored.
      const naive = newTerm(ncols, nrows);
      const decoder = new TextDecoder('utf-8', { fatal: false });
      for (const ev of fx.events) {
        if (ev[0] === 'o') await writeAsync(naive, decoder.decode(b64ToBytes(ev[1]), { stream: true }));
      }

      expect(snapshot(naive).lines).not.toEqual(snapshot(ref).lines);
    });
  }
});
