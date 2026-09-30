import { connectionManager, toplog, type Shell } from '@sdk';
import type { OutputChunk } from '@sdk/pty-sync/types';
import type { Terminal as XTerm } from '@xterm/xterm';
import { useEffect, useRef } from 'react';
import { fetchPtyStream, replayPtyStream, saveReplayCheckpoint } from './interactive-terminal/pty-replay';

/** Which trigger ran an attach — the same shell fetching its stream several times per mount shows up here. */
export type AttachSource = 'mount' | 'status' | 'recovered' | 'reconnected';

export interface AttachedInfo {
  source: AttachSource;
  /** Whether anything (history or backlog) was written to the terminal. */
  wrote: boolean;
  ms: number;
  historyKb: number;
  chunks: number;
}

export interface XtermShellAttachOptions {
  /** The xterm is open and fitted — replay written before that lands at 80×24. */
  ready: boolean;
  /** Every chunk this attach writes or skips (backlog and live), before it is written. */
  onChunk?: (chunk: OutputChunk) => void;
  /** Writes one piece of LIVE output; the default writes it to the terminal as is. */
  write?: (data: string) => void;
  /** An attach finished: history and backlog are on screen and live output flows. */
  onAttached?: (info: AttachedInfo) => void;
  /** The shell disconnected or the view let go: live output stopped reaching the terminal. */
  onDetached?: () => void;
  /** A recovered-session broadcast is this terminal's too (its owning process's id). */
  recoveredFor?: (msg: { shell_id?: string; process_id?: string }) => boolean;
  /**
   * Drop the recorded screen's empty rows under the last output. A stream recorded at another
   * size (a deployment's 30-row terminal) written into a smaller view would scroll its real lines
   * out and leave blank rows showing.
   */
  trimRecordedBlankRows?: boolean;
}

/**
 * Keep an xterm showing a shell's terminal: what it printed before this view attached (the
 * recorded stream, replayed at its recorded sizes), then everything it prints live.
 *
 * ONE attach for every terminal view. It runs when the shell connects (`status`), when the view
 * mounts on an already-connected shell, when the backend respawned the session (`on_recovered`)
 * and after a WebSocket reconnect (`on_reconnected`, to repaint the gap) — each re-run supersedes
 * one in flight. Starting the shell is not its job: `shell.ensureStarted()`.
 */
export function useXtermShellAttach(
  shell: Shell | null,
  term: XTerm | null,
  { ready, ...callbacks }: XtermShellAttachOptions,
): void {
  // Callbacks change every render; the attach reads the latest without re-subscribing.
  const cb = useRef(callbacks);
  cb.current = callbacks;

  useEffect(() => {
    if (!shell || !term || !ready) return;
    let unsubOutput: (() => void) | undefined;
    let connectGen = 0; // a newer connect/disconnect wins
    const shellId = shell.id;

    const onConnected = (source: AttachSource) => {
      const gen = ++connectGen;
      const started = performance.now();
      toplog.log('pty', `on_connected start shell=${shellId} source=${source} gen=${gen}`);
      void (async () => {
        let history: string | null = null;
        let historyLastSeq = 0;
        try {
          const ptyId = shell.pty_pid ?? shell.id;
          const tFetch = performance.now();
          const stream = await fetchPtyStream(ptyId);
          const tReplay = performance.now();
          toplog.log(
            ['process_load', 'pty', 'agentic_process.load'],
            `onConnected pty-stream fetch took ${(tReplay - tFetch).toFixed(1)}ms events=${stream?.events.length ?? 0} pty=${ptyId.slice(0, 8)}`,
          );
          if (gen !== connectGen) return; // don't burn a full replay for a dead attach
          if (stream) {
            const replay = await replayPtyStream(stream);
            toplog.log(
              ['process_load', 'pty', 'agentic_process.load'],
              `onConnected replay took ${(performance.now() - tReplay).toFixed(1)}ms serializedKB=${replay ? (replay.serialized.length / 1024).toFixed(1) : 0}`,
            );
            if (replay) {
              history = cb.current.trimRecordedBlankRows
                ? replay.serialized.replace(/(?:\r\n)+\x1b\[\d+A$/, '')
                : replay.serialized;
              historyLastSeq = replay.lastSeq;
              // The next cold open of this recording replays only what comes after this.
              saveReplayCheckpoint(ptyId, stream, replay);
            }
          }
        } catch (e) {
          // Live-only: a legacy session with no stream, or a replay error.
          toplog.log('pty', `on_connected replay_failed shell=${shellId} source=${source} error=${String(e)}`);
        }
        if (gen !== connectGen) return;

        term.reset();
        if (history) term.write(history);
        // Chunks that arrived since attach, minus what the recording already covered (frames and
        // chunks share one per-session seq). One STREAMING decoder over all of them, skipped ones
        // included — xterm's raw-bytes path drops a multi-byte char split across writes.
        const chunks = shell.getPtyChunks();
        const decoder = new TextDecoder('utf-8', { fatal: false });
        let wrote = Boolean(history);
        for (const chunk of chunks) {
          cb.current.onChunk?.(chunk);
          const text = decoder.decode(chunk.data, { stream: true });
          if (chunk.seq <= historyLastSeq) continue;
          term.write(text);
          wrote = true;
        }
        // Assert this view's size on the PTY: the SIGWINCH repaints a running TUI at it.
        if (shell.connected) void shell.resize(term.cols, term.rows);

        unsubOutput?.();
        unsubOutput = shell.onOutput((data, seq) => {
          if (seq !== undefined) {
            const chunk = shell.getPtyChunk(seq);
            if (chunk) cb.current.onChunk?.(chunk);
          }
          (cb.current.write ?? ((d: string) => term.write(d)))(data);
        });
        const info = {
          source,
          wrote,
          ms: performance.now() - started,
          historyKb: history ? history.length / 1024 : 0,
          chunks: chunks.length,
        };
        toplog.log('pty', `on_connected done shell=${shellId} source=${source} gen=${gen} ms=${info.ms.toFixed(0)} chunks=${info.chunks}`);
        cb.current.onAttached?.(info);
      })();
    };

    const onDisconnected = () => {
      connectGen++; // cancel an in-flight replay
      unsubOutput?.();
      unsubOutput = undefined;
      cb.current.onDetached?.();
    };

    const unsubStatus = shell.on('status', (s: string) => {
      if (s === 'connected') onConnected('status');
      if (s === 'disconnected') onDisconnected();
    });
    // The backend's recovery watchdog respawned this session after a server restart.
    const onRecovered = (msg: { shell_id?: string; process_id?: string }) => {
      if (msg?.shell_id === shellId || cb.current.recoveredFor?.(msg)) onConnected('recovered');
    };
    // Membership is restored by the backend on a WS reconnect; this only repaints the gap.
    const onReconnected = () => onConnected('reconnected');
    connectionManager.on('on_recovered', onRecovered);
    connectionManager.on('on_reconnected', onReconnected);
    if (shell.connected) onConnected('mount');

    return () => {
      connectGen++;
      unsubStatus();
      connectionManager.off('on_recovered', onRecovered);
      connectionManager.off('on_reconnected', onReconnected);
      unsubOutput?.();
      cb.current.onDetached?.();
    };
  }, [shell, term, ready]);
}
