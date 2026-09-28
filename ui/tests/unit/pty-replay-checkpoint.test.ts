/**
 * A checkpoint plus the tail restores exactly the terminal a full replay does
 * (docs/navigation/dock-loading.md, step 7).
 *
 * A cold open used to replay a session's WHOLE recording in a headless xterm —
 * 0.8 s of a 2 s open on a long session. It now starts from a stored checkpoint
 * (the serialized terminal after frame N) and replays only the frames after it.
 * That is only a speed-up if it is indistinguishable: for every split point —
 * including right before and after a resize — restoring checkpoint+tail must give
 * the same lines, cursor and size as restoring the full replay.
 */
import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/headless';
import {
  replayPtyStream,
  type FramedPtyStream,
} from '../../src/components/terminal/interactive-terminal/pty-replay';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

/** A session with scrolling text, color, cursor addressing, a multi-byte glyph split across frames, and resizes. */
function recording(): FramedPtyStream {
  const events: FramedPtyStream['events'] = [];
  let seq = 0;
  const out = (s: string) => events.push(['o', b64(s), ++seq]);
  for (let i = 0; i < 60; i++) out(`line ${i} \x1b[3${i % 7}mcolor\x1b[0m ${'x'.repeat(i % 50)}\r\n`);
  events.push(['r', [100, 30]]);
  out('\x1b[5;10Hpositioned\x1b[H');
  // "é" (0xC3 0xA9) split across two frames: the streaming decoder must hold the half.
  events.push(['o', Buffer.from([0x63, 0x61, 0x66, 0xc3]).toString('base64'), ++seq]);
  events.push(['o', Buffer.from([0xa9, 0x0d, 0x0a]).toString('base64'), ++seq]);
  events.push(['r', [72, 20]]);
  for (let i = 60; i < 120; i++) out(`after resize ${i} ${'y'.repeat(i % 70)}\r\n`);
  out('\x1b[?1003h\x1b[?1006h'); // a TUI asks for SGR mouse reports
  out('prompt> ');
  return { v: 1, cols: 80, rows: 24, base: 0, events };
}

function restore(serialized: string, cols: number, rows: number): Promise<Terminal> {
  const term = new Terminal({ cols, rows, scrollback: 50000, allowProposedApi: true });
  return new Promise((resolve) => term.write(serialized, () => resolve(term)));
}

function snapshot(term: Terminal) {
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return { lines, cursor: [buf.baseY + buf.cursorY, buf.cursorX], size: [term.cols, term.rows] };
}

async function viaCheckpointAt(full: FramedPtyStream, k: number) {
  const prefix = await replayPtyStream({ ...full, events: full.events.slice(0, k) });
  expect(prefix).not.toBeNull();
  return replayPtyStream({
    ...full,
    base: k,
    events: full.events.slice(k),
    checkpoint: { cols: prefix!.cols, rows: prefix!.rows, last_seq: prefix!.lastSeq, serialized: prefix!.serialized },
  });
}

describe('replay from a checkpoint', () => {
  const full = recording();
  const resizeAt = full.events.flatMap((e, i) => (e[0] === 'r' ? [i] : []));
  const splits = [1, 30, ...resizeAt.flatMap((i) => [i, i + 1]), full.events.length - 1, full.events.length];

  it.each(splits)('checkpoint after frame %i + the tail == the full replay', async (k) => {
    const whole = await replayPtyStream(full);
    const resumed = await viaCheckpointAt(full, k);
    expect([resumed!.cols, resumed!.rows]).toEqual([whole!.cols, whole!.rows]);
    expect(resumed!.lastSeq).toBe(whole!.lastSeq);
    const a = snapshot(await restore(whole!.serialized, whole!.cols, whole!.rows));
    const b = snapshot(await restore(resumed!.serialized, resumed!.cols, resumed!.rows));
    expect(b).toEqual(a);
  });

  it('keeps the SGR mouse encoding a TUI asked for before the checkpoint', async () => {
    const tuiAt = full.events.length - 1; // the mouse request is the frame before the prompt
    const resumed = await viaCheckpointAt(full, tuiAt);
    expect(resumed!.serialized).toContain('\x1b[?1006h');
  });

  it('with nothing after the checkpoint, the checkpoint IS the terminal — no replay', async () => {
    const checkpoint = { cols: 90, rows: 25, last_seq: 42, serialized: 'SCREEN' };
    const result = await replayPtyStream({ v: 1, cols: 80, rows: 24, base: 99, events: [], checkpoint });
    expect(result).toEqual({ serialized: 'SCREEN', lastSeq: 42, cols: 90, rows: 25 });
  });
});
