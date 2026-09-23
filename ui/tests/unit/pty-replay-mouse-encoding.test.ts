/**
 * The attach-time replay must hand the visible terminal the mouse ENCODING the
 * program chose, not just the tracking mode.
 *
 * `SerializeAddon` writes `?1003h` (tracking) but never `?1006h` (SGR). A
 * fullscreen TUI (Claude Code) asks for both; after a re-attach the visible
 * xterm had tracking on with the DEFAULT (X10) encoding, and xterm emits X10
 * mouse reports on `onBinary`, which nothing forwards to the PTY. Every wheel
 * tick was dropped (measured live 2026-09-23: `activeEncoding: "DEFAULT"`,
 * `onData: []`, report on `onBinary`).
 */
import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/headless';
import { replayPtyStream, type FramedPtyStream } from '../../src/components/terminal/interactive-terminal/pty-replay';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const write = (t: Terminal, s: string) => new Promise<void>((r) => t.write(s, r));

// What the visible terminal ends up with after InteractiveTerminal writes the replay.
async function restore(stream: FramedPtyStream): Promise<Terminal> {
  const replay = await replayPtyStream(stream);
  expect(replay).not.toBeNull();
  const term = new Terminal({ cols: replay!.cols, rows: replay!.rows, allowProposedApi: true });
  await write(term, replay!.serialized);
  return term;
}

// A wheel-up at cell (10,5), fired through xterm's own mouse service.
function wheelUp(term: Terminal): { data: string[]; binary: string[] } {
  const data: string[] = [];
  const binary: string[] = [];
  term.onData((d) => data.push(d));
  term.onBinary((d) => binary.push(d));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (term as any)._core.coreMouseService.triggerMouseEvent({
    // button 4 = wheel; action 0 = up (xterm's CoreMouseAction), encoded as 64
    col: 10, row: 5, x: 0, y: 0, button: 4, action: 0, ctrl: false, alt: false, shift: false,
  });
  return { data, binary };
}

const stream = (...outputs: string[]): FramedPtyStream => ({
  v: 1,
  cols: 80,
  rows: 24,
  events: outputs.map((o, i) => ['o', b64(o), i + 1]),
});

describe('replayPtyStream keeps the mouse encoding', () => {
  it('SGR requested by the program → wheel reports reach onData as SGR', async () => {
    const term = await restore(stream('\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h', 'hello'));
    const { data, binary } = wheelUp(term);
    expect(binary).toEqual([]);
    expect(data).toEqual(['\x1b[<64;11;6M']);
  });

  it('a combined parameter list and a split frame still count', async () => {
    const term = await restore(stream('\x1b[?1049h\x1b[?1003;10', '06h', 'hello'));
    expect(wheelUp(term).data).toEqual(['\x1b[<64;11;6M']);
  });

  it('SGR turned off again → stays off', async () => {
    const term = await restore(stream('\x1b[?1003h\x1b[?1006h', '\x1b[?1006l', 'x'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((term as any)._core.coreMouseService.activeEncoding).toBe('DEFAULT');
  });
});
