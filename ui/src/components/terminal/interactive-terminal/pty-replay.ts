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

// `@xterm/addon-serialize` types `activate()` against `@xterm/xterm`'s Terminal,
// so loading it into an `@xterm/headless` one does not type-check — even though
// it is exactly what this module does and what the addon supports. Verified
// against the shipped addon: the only terminal members it touches are `buffer`,
// `options` and `rows`, all of which `@xterm/headless` implements.
//
// So the upstream signature is too NARROW, not wrong about us. Widening it here
// states that, where a cast at the call site would only have hidden it.
declare module '@xterm/addon-serialize' {
  interface SerializeAddon {
    activate(terminal: import('@xterm/headless').Terminal): void;
  }
}

/** A stored replay result: the terminal as it stood before the stream's `base` frame, at cols x rows. */
export interface PtyReplayCheckpoint {
  cols: number;
  rows: number;
  last_seq: number;
  serialized: string;
}

/** Framed stream as served by GET /api/v1/shell/{shell_id}/pty-stream. */
export interface FramedPtyStream {
  v: number;
  cols: number | null;
  rows: number | null;
  /** Absolute number of `events[0]` (frames dropped by truncation, or the checkpoint's frame). */
  base?: number;
  events: Array<[string, ...unknown[]]>;
  /** `?since=checkpoint`: the state `events` continue from. */
  checkpoint?: PtyReplayCheckpoint;
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

/**
 * Fetch the framed stream for a shell; null when none recorded (404). Asks for the
 * stored checkpoint plus only the frames after it (docs/navigation/dock-loading.md,
 * step 7) — the server answers with the whole recording when it has no usable one.
 */
export async function fetchPtyStream(shellId: string): Promise<FramedPtyStream | null> {
  try {
    const data = await apiClient.get<FramedPtyStream>(`/shell/${shellId}/pty-stream`, {
      params: { since: 'checkpoint' },
    });
    if (!data || !Array.isArray(data.events)) return null;
    return data;
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
  const checkpoint = stream.checkpoint;
  // Nothing happened since the checkpoint: it IS the terminal — no replay at all.
  if (checkpoint && !stream.events.length) {
    return { serialized: checkpoint.serialized, lastSeq: checkpoint.last_seq, cols: checkpoint.cols, rows: checkpoint.rows };
  }
  if (!stream.events.length) return null;
  // Legacy (v0) raw recordings have no recorded size — replaying them at a
  // guessed width is exactly the garble this design eliminates. Skip.
  if (!checkpoint && (stream.cols == null || stream.rows == null)) return null;

  // From a checkpoint, the tail continues at the checkpoint's size; otherwise the
  // recording starts at the header's.
  let cols = checkpoint?.cols ?? (stream.cols as number);
  let rows = checkpoint?.rows ?? (stream.rows as number);
  const term = new HeadlessTerminal({
    cols,
    rows,
    scrollback: REPLAY_SCROLLBACK,
    allowProposedApi: true,
  });
  const serializeAddon = new SerializeAddon();
  term.loadAddon(serializeAddon);

  // SerializeAddon restores the mouse TRACKING mode (?1003h) but not the
  // ENCODING (?1006h SGR / ?1016h SGR-pixels). A TUI that asked for both
  // (Claude Code's fullscreen UI) would come back with tracking on and the
  // default X10 encoding, and xterm emits X10 reports on `onBinary`, which
  // nothing forwards to the PTY: every wheel tick and click was dropped.
  // So watch the program's own mode switches through the parser (exact across
  // split frames and `?1003;1006h` lists) and re-apply the last one.
  let mouseEncoding = '';
  const trackEncoding = (set: boolean) => (params: (number | number[])[]) => {
    for (const p of params) {
      if (p === 1006 || p === 1016) mouseEncoding = set ? `\x1b[?${p}h` : '';
    }
    return false; // observe only; xterm still applies the mode
  };
  term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, trackEncoding(true));
  term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, trackEncoding(false));

  const decoder = new TextDecoder('utf-8', { fatal: false });
  let lastSeq = 0;
  let flush: Promise<void> = Promise.resolve();
  const write = (text: string) =>
    (flush = new Promise<void>((resolve) => term.write(text, resolve)));

  // Batch consecutive output events into ONE term.write per resize segment.
  // xterm's WriteBuffer yields to the macrotask queue between write entries
  // (12ms slices) — one entry per frame turns a busy main thread into a
  // tens-of-seconds replay, since every slice waits behind the app's other
  // work. Bytes are still decoded per-frame with the STREAMING decoder, so
  // the multi-byte-split discipline is unchanged; only the write granularity
  // is coarser (segment, not frame).
  let pendingOutput: string[] = [];
  const flushPendingOutput = () => {
    if (pendingOutput.length) {
      void write(pendingOutput.join('')); // awaited via `flush`
      pendingOutput = [];
    }
  };

  try {
    if (checkpoint) {
      // The checkpoint's own trailing mouse-encoding suffix passes through the
      // parser hooks above, so `mouseEncoding` resumes where it left off.
      void write(checkpoint.serialized);
      lastSeq = checkpoint.last_seq;
    }
    for (const ev of stream.events) {
      if (ev[0] === 'o' && typeof ev[1] === 'string') {
        pendingOutput.push(decoder.decode(base64ToBytes(ev[1]), { stream: true }));
        if (typeof ev[2] === 'number' && ev[2] > lastSeq) lastSeq = ev[2];
      } else if (ev[0] === 'r' && Array.isArray(ev[1])) {
        const [c, r] = ev[1] as [number, number];
        flushPendingOutput();
        await flush; // resize must not overtake queued output
        term.resize(c, r);
        cols = c;
        rows = r;
      }
    }
    flushPendingOutput();
    await flush;
    const serialized = serializeAddon.serialize({ scrollback: REPLAY_SCROLLBACK }) + mouseEncoding;
    return { serialized, lastSeq, cols, rows };
  } finally {
    term.dispose();
  }
}

/**
 * Frames a replay must cover before its result is worth storing as a checkpoint:
 * below this the tail replays in a few ms, and the upload (the serialized screen,
 * up to megabytes) would cost more than it saves.
 */
export const CHECKPOINT_MIN_FRAMES = 500;

/**
 * Store a replay result as the recording's checkpoint, so the next cold open
 * replays only what comes after it. Fire-and-forget: a failed store only means
 * the next open replays more.
 */
export function saveReplayCheckpoint(shellId: string, stream: FramedPtyStream, result: ReplayResult): void {
  if (stream.events.length < CHECKPOINT_MIN_FRAMES) return;
  const frame = (stream.base ?? 0) + stream.events.length;
  void apiClient
    .post(`/shell/${shellId}/pty-stream/checkpoint`, {
      frame,
      cols: result.cols,
      rows: result.rows,
      last_seq: result.lastSeq,
      serialized: result.serialized,
    })
    .catch(() => {});
}
