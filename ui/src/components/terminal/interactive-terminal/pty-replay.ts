/**
 * Attach-time PTY history replay.
 *
 * On terminal (re)attach, the backend's framed stream (output + resize
 * frames; see flow_sdk/compute/providers/desktop/pty_stream_file.py) is
 * replayed through a headless xterm AT THE RECORDED SIZES, serialized, and
 * the result written into the visible terminal — restoring full scrollback
 * without garbling. Validated by the replay-equivalence fuzz matrix
 * (tests/pty_fuzz/, ui/tests/unit/pty-replay-*.test.ts).
 *
 * Two non-negotiable disciplines, both fuzz-derived:
 * - Bytes are decoded with a STREAMING TextDecoder before term.write() —
 *   xterm's own Uint8Array path drops multi-byte chars split across writes
 *   (https://github.com/xtermjs/xterm.js/issues/6003).
 * - Queued output is flushed before every resize, so resizes can't overtake
 *   output in xterm's async write queue.
 */
import { SerializeAddon } from '@xterm/addon-serialize';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { apiClient } from '@sdk';
import { base64ToBytes } from '@sdk/services/shell/ptyConnection.js';

/** Framed stream as served by GET /api/v1/shell/{shell_id}/pty-stream. */
export interface FramedPtyStream {
  v: number;
  cols: number | null;
  rows: number | null;
  events: Array<[string, ...unknown[]]>;
}

export interface ReplayResult {
  /** VT-serialized terminal state (scrollback + screen + cursor). */
  serialized: string;
  /** Highest output-frame seq replayed (0 if frames carry no seq). */
  lastSeq: number;
  /** Size in effect at the end of the recording. */
  cols: number;
  rows: number;
}

/** Fetch the framed stream for a shell; null when none recorded (404). */
export async function fetchPtyStream(shellId: string): Promise<FramedPtyStream | null> {
  try {
    const data = await apiClient.get<FramedPtyStream>(`/shell/${shellId}/pty-stream`);
    if (!data || !Array.isArray((data as FramedPtyStream).events)) return null;
    return data as FramedPtyStream;
  } catch {
    return null; // 404 (no stream) or transient failure — caller falls back
  }
}

const REPLAY_SCROLLBACK = 50000; // matches the visible terminal's scrollback

/**
 * Replay a framed stream through a headless xterm at the recorded sizes and
 * serialize the resulting state. Returns null for empty/legacy-sized streams
 * where faithful replay is impossible (v0 legacy files have unknown size).
 */
export async function replayPtyStream(stream: FramedPtyStream): Promise<ReplayResult | null> {
  if (!stream.events.length) return null;
  // Legacy (v0) raw recordings have no recorded size — replaying them at a
  // guessed width is exactly the garble this design eliminates. Skip.
  if (stream.cols == null || stream.rows == null) return null;

  let cols = stream.cols;
  let rows = stream.rows;
  const term = new HeadlessTerminal({
    cols,
    rows,
    scrollback: REPLAY_SCROLLBACK,
    allowProposedApi: true,
  });
  const serializeAddon = new SerializeAddon();
  term.loadAddon(serializeAddon);

  const decoder = new TextDecoder('utf-8', { fatal: false });
  let lastSeq = 0;
  let flush: Promise<void> = Promise.resolve();
  const write = (text: string) =>
    (flush = new Promise<void>((resolve) => term.write(text, resolve)));

  try {
    for (const ev of stream.events) {
      if (ev[0] === 'o' && typeof ev[1] === 'string') {
        write(decoder.decode(base64ToBytes(ev[1]), { stream: true }));
        if (typeof ev[2] === 'number' && ev[2] > lastSeq) lastSeq = ev[2];
      } else if (ev[0] === 'r' && Array.isArray(ev[1])) {
        const [c, r] = ev[1] as [number, number];
        await flush; // resize must not overtake queued output
        term.resize(c, r);
        cols = c;
        rows = r;
      }
    }
    await flush;
    const serialized = serializeAddon.serialize({ scrollback: REPLAY_SCROLLBACK });
    return { serialized, lastSeq, cols, rows };
  } finally {
    term.dispose();
  }
}
