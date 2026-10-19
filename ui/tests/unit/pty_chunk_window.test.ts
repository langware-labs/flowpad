/**
 * PtyConnection keeps a bounded replay WINDOW of output chunks, not the session's history.
 *
 * A TUI that redraws one line (a `\r` spinner, a status line) sends one chunk per frame while
 * the screen stays one row; before the window every frame stayed in `chunks` for the life of
 * the shell (~310 B/frame in the browser, linear for hours). Feeds the real `PtyConnection`
 * through `appendOutput` — the one-line `routeOutput` delegate is what the store calls.
 */

import { PtyConnection } from '@sdk/services/shell/ptyConnection';
import { describe, expect, it } from 'vitest';

function b64(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64');
}

function makePty(): PtyConnection {
  const pc = new PtyConnection('test-shell', 'test-node');
  (pc as unknown as { _attached: boolean })._attached = true;
  return pc;
}

const MAX = PtyConnection.CHUNK_WINDOW_MAX_CHUNKS;

/** One spinner frame: CR, a counter, erase-to-EOL (~46 bytes, like a real TUI frame). */
function frame(i: number): string {
  return b64(`\r[${String(i % 60).padStart(2, '0')}] spin ${String(i).padStart(6, '0')} \x1b[K`);
}

describe('PtyConnection chunk window', () => {
  it('holds at most CHUNK_WINDOW_MAX_CHUNKS entries across two windows of redraw frames', () => {
    const pc = makePty();
    const seen: number[] = [];
    let lines = 0;
    pc.onOutput((_data, seq) => {
      // What useXtermShellAttach does on every live chunk: read it back by seq.
      expect(pc.getChunk(seq!)).toBeDefined();
      seen.push(seq!);
    });
    pc.onLine(() => lines++);

    const total = MAX * 2;
    for (let seq = 1; seq <= total; seq++) {
      pc.appendOutput(frame(seq), seq, 1_700_000_000_000 + seq);
      expect(pc.chunks.size).toBeLessThanOrEqual(MAX);
    }

    expect(pc.chunks.size).toBe(MAX);
    expect(pc.lastSeq).toBe(total);
    expect(seen.length).toBe(total);
    expect(lines).toBe(total); // the line stream saw every frame; the window dropped none of them
    expect(pc.trimmedThroughSeq).toBe(total - MAX);
    // The window is the NEWEST chunks, in seq order, and the newest is always present.
    const sorted = pc.getSortedChunks();
    expect(sorted[0].seq).toBe(total - MAX + 1);
    expect(sorted[sorted.length - 1].seq).toBe(total);
    expect(pc.getChunk(total)).toBeDefined();
    expect(pc.getChunk(total - MAX)).toBeUndefined();
  });

  it('bounds payload bytes: large chunks are dropped before the count bound is reached', () => {
    const pc = makePty();
    const big = b64('x'.repeat(64 * 1024)); // 64 KiB per chunk
    const n = Math.ceil(PtyConnection.CHUNK_WINDOW_MAX_BYTES / (64 * 1024)) + 8;
    for (let seq = 1; seq <= n; seq++) pc.appendOutput(big, seq);
    const bytes = [...pc.chunks.values()].reduce((a, c) => a + c.data.length, 0);
    expect(bytes).toBeLessThanOrEqual(PtyConnection.CHUNK_WINDOW_MAX_BYTES);
    expect(pc.chunks.size).toBeLessThan(n);
    expect(pc.getChunk(n)).toBeDefined();
  });

  it('never drops the chunk that just arrived, even when it alone exceeds the byte bound', () => {
    const pc = makePty();
    const huge = b64('y'.repeat(PtyConnection.CHUNK_WINDOW_MAX_BYTES + 1));
    pc.appendOutput(huge, 1);
    expect(pc.chunks.size).toBe(1);
    expect(pc.getChunk(1)?.data.length).toBe(PtyConnection.CHUNK_WINDOW_MAX_BYTES + 1);
    // The next small chunk evicts the oversized one, and the byte counter is back in step.
    pc.appendOutput(frame(2), 2);
    expect([...pc.chunks.keys()]).toEqual([2]);
  });

  it('clear() resets the window so it refills to the same size after a re-attach', () => {
    const pc = makePty();
    for (let seq = 1; seq <= MAX + 100; seq++) pc.appendOutput(frame(seq), seq);
    expect(pc.trimmedThroughSeq).toBe(100);
    pc.clear();
    expect(pc.chunks.size).toBe(0);
    expect(pc.trimmedThroughSeq).toBe(0);
    for (let seq = 1; seq <= MAX + 100; seq++) pc.appendOutput(frame(seq), seq);
    expect(pc.chunks.size).toBe(MAX);
    expect(pc.trimmedThroughSeq).toBe(100);
  });

  it('a late addTrigger catches up on lines still inside the window only', () => {
    const pc = makePty();
    const total = MAX + 50;
    for (let seq = 1; seq <= total; seq++) pc.appendOutput(b64(`line ${seq}\n`), seq);
    const hits: string[] = [];
    pc.addTrigger({
      pattern: /^line (\d+)$/,
      onMatch: (line) => hits.push(line),
    });
    expect(hits).toContain(`line ${total}`);
    expect(hits).toContain(`line ${total - MAX + 1}`);
    expect(hits).not.toContain('line 50');
  });
});
