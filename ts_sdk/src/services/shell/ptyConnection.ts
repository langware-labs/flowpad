import { dataContext } from '../../FlowSync/context';
import type { OutputChunk } from '../../pty-sync/types.js';
import type { OrphanEntry } from './ptyOrphanBuffer';

export type PtyOutputListener = (data: string, seq?: number) => void;
export type PtyLineListener = (line: string) => void;
/**
 * Pattern watcher registered via ``Shell.addTrigger`` /
 * ``PtyConnection.addTrigger``. ``onMatch`` fires when an ANSI-stripped PTY
 * line matches ``pattern``. ``label`` is shown in the PTY Events Viewer; if
 * absent, the viewer falls back to ``pattern.toString()``.
 */
export type PtyEvent = {
  pattern: RegExp;
  onMatch: (line: string, match: RegExpMatchArray) => void;
  label?: string;
};

/** A single recorded fire of a registered ``PtyEvent`` — buffered in
 *  ``PtyConnection`` and surfaced in the PTY Events Viewer. */
export interface PtyEventFire {
  /** Local uuid for stable React keys. */
  id: string;
  /** ``Date.now()`` at fire time. */
  ts: number;
  /** ``pattern.toString()`` — the regex literal source. */
  patternSource: string;
  /** ``PtyEvent.label`` if set by the caller. */
  label?: string;
  /** ANSI-stripped line that matched. */
  line: string;
  /** First 8 capture groups (or fewer) from the match — slice protects the buffer. */
  match: string[];
  /** True iff the fire happened during the replay phase (pre-attach). */
  duringReplay: boolean;
}

export type PtyEventFireListener = (fire: PtyEventFire) => void;

export type PtyConnectionStatus = 'idle' | 'connecting' | 'live' | 'restarting' | 'closed';

/** Strip CSI/SGR escape sequences so regex matchers see plain text.
 *
 * Matches the most common ANSI control sequences emitted by terminal
 * applications: CSI (`ESC [ ... letter`), OSC (`ESC ] ... BEL/ST`), and
 * single-character escapes. Not exhaustive — bracketed paste mode and
 * unusual DCS sequences may slip through — but covers >99% of real PTY
 * output Claude Code / shell prompts produce.
 */
const ANSI_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

export class PtyConnection {
  shellId: string;
  computeNodeId: string;

  // ── Internal state (moved from Shell) ────────────────────────────────────
  started = false;
  restarting = false;
  lastSeq = 0;

  /** Replay chunks keyed by seq. */
  readonly chunks: Map<number, OutputChunk> = new Map();

  private readonly decoder = new TextDecoder('utf-8', { fatal: false });

  /** Live output listeners — only notified after isReady. */
  private readonly _listeners = new Set<PtyOutputListener>();

  /** Line listeners — fed by every chunk (including replay). ANSI-stripped. */
  private readonly _lineListeners = new Set<PtyLineListener>();

  /** Active triggers — pattern + onMatch. Wrapped over the line stream. */
  private readonly _triggers = new Set<PtyEvent>();

  /** Bounded ring of fire records — surfaced in PTY Events Viewer. */
  private readonly _eventFires: PtyEventFire[] = [];
  private readonly _eventFireListeners = new Set<PtyEventFireListener>();
  private static readonly MAX_EVENT_FIRES = 200;

  /** Pending raw text not yet terminated by \n. Fed into the line stream. */
  private _lineBuffer = '';

  /** onReady subscribers — fired once when replay completes + live stream opens. */
  private readonly _readyListeners = new Set<() => void>();

  /** onDisconnect subscribers — fired when WS closes. */
  private readonly _disconnectListeners = new Set<() => void>();

  /** True once attach() has finished replay and the output gate is open. */
  private _replayDone = false;

  /** Backend PTY ID currently attached in this browser client. */
  private _attachedPtyId: string | null = null;

  /** In-flight attach dedup guard. */
  private _attachPromise: Promise<void> | null = null;

  /** PTY ID currently being attached. */
  private _attachingPtyId: string | null = null;

  constructor(shellId = '', computeNodeId = '') {
    this.shellId = shellId;
    this.computeNodeId = computeNodeId;
  }

  // ── Status ────────────────────────────────────────────────────────────────

  /** True once attach() has finished replay (no WS dependency — safe in unit tests). */
  get replayDone(): boolean {
    return this._replayDone;
  }

  /** True if this connection is fully attached to the given PTY (started + replay done). */
  isAttachedTo(ptyId: string): boolean {
    return this.started && this._replayDone && this._attachedPtyId === ptyId;
  }

  /**
   * True when replay is done AND the WS is live.
   * Equivalent to the old shell.connected.
   */
  get isReady(): boolean {
    return this._replayDone && this.isLive;
  }

  /** True when the backend PTY is started and WS is live (no replay gate). */
  get isLive(): boolean {
    return this.started && !this.restarting && dataContext.isConnected;
  }

  get status(): PtyConnectionStatus {
    if (!this.started) return this.restarting ? 'restarting' : 'idle';
    if (this.restarting) return 'restarting';
    return 'live';
  }

  // ── Sorted chunk accessor ─────────────────────────────────────────────────

  /** Sorted replay chunks — read on ready to write into xterm. */
  getSortedChunks(): OutputChunk[] {
    return [...this.chunks.values()].sort((a, b) => a.seq - b.seq);
  }

  /** Single chunk by seq — for ptySyncRef.processChunk(). */
  getChunk(seq: number): OutputChunk | undefined {
    return this.chunks.get(seq);
  }

  // ── Output routing (called by Shell / DataManager) ────────────────────────

  /**
   * Route a pty_output_msg chunk into this connection.
   * Stores chunk for replay; notifies live listeners only after isReady.
   */
  routeOutput(data: string, seq?: number, timestamp_ms?: number): string | null {
    return this.appendOutput(data, seq, timestamp_ms);
  }

  /**
   * Decode and store a base64-encoded PTY output chunk.
   * Returns decoded string, or null if deduped/failed.
   */
  appendOutput(base64Data: string, seq?: number, timestamp_ms?: number): string | null {
    if (seq !== undefined) {
      if (seq <= this.lastSeq && this.lastSeq > 0) return null; // dedup
      this.lastSeq = seq;
    }
    let bytes: Uint8Array;
    let decoded: string;
    try {
      const binaryStr = atob(base64Data);
      bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
      decoded = this.decoder.decode(bytes, { stream: true });
    } catch (e) {
      console.warn('[PtyConnection] Failed to decode base64 PTY data:', e);
      return null;
    }
    if (seq !== undefined) {
      this.chunks.set(seq, { seq, data: bytes, timestamp: timestamp_ms ?? Date.now() });
    }
    // Feed line listeners regardless of replay state — triggers must fire
    // for replayed output too so reload-time pattern detection works.
    this._feedLineBuffer(decoded);
    // Only fire live listeners after replay phase is complete.
    // Gate on _replayDone only (not isLive) so unit tests work without a WS.
    if (this._replayDone) {
      for (const listener of this._listeners) {
        try {
          listener(decoded, seq);
        } catch (e) {
          console.error('[PtyConnection] listener error:', e);
        }
      }
    }
    return decoded;
  }

  // ── Line stream ───────────────────────────────────────────────────────────

  /**
   * Subscribe to ANSI-stripped lines. Fires on every \n found in the raw
   * stream — replayed chunks included. Trailing partial line (no newline)
   * is buffered until the next chunk arrives.
   *
   * Returns an unsubscribe function.
   */
  onLine(fn: PtyLineListener): () => void {
    this._lineListeners.add(fn);
    return () => this._lineListeners.delete(fn);
  }

  /**
   * Register a regex trigger over the line stream. ``onMatch`` fires
   * with the matched line and the regex match groups.
   *
   * Returns an unsubscribe function.
   */
  addTrigger(trigger: PtyEvent): () => void {
    this._triggers.add(trigger);
    return () => this._triggers.delete(trigger);
  }

  /** Number of currently-registered ``PtyEvent`` watchers. */
  getRegisteredEventCount(): number {
    return this._triggers.size;
  }

  /** Snapshot of buffered fire records (oldest first). */
  getEventFires(): readonly PtyEventFire[] {
    return this._eventFires;
  }

  /** Subscribe to new fires. Returns an unsubscribe function. */
  onEventFire(fn: PtyEventFireListener): () => void {
    this._eventFireListeners.add(fn);
    return () => this._eventFireListeners.delete(fn);
  }

  /** Drop all buffered fires (does not affect listeners or watchers). */
  clearEventFires(): void {
    this._eventFires.length = 0;
  }

  private _feedLineBuffer(decoded: string): void {
    this._lineBuffer += decoded;
    let nl = this._lineBuffer.indexOf('\n');
    while (nl !== -1) {
      // Slice off the line (keep trailing CR off if present).
      let line = this._lineBuffer.slice(0, nl);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this._lineBuffer = this._lineBuffer.slice(nl + 1);
      this._emitLine(stripAnsi(line));
      nl = this._lineBuffer.indexOf('\n');
    }
  }

  private _emitLine(line: string): void {
    for (const fn of this._lineListeners) {
      try {
        fn(line);
      } catch (e) {
        console.error('[PtyConnection] line listener error:', e);
      }
    }
    for (const trig of this._triggers) {
      const m = line.match(trig.pattern);
      if (m) {
        try {
          trig.onMatch(line, m);
        } catch (e) {
          console.error('[PtyConnection] trigger error:', e);
        }
        this._recordEventFire(trig, line, m);
      }
    }
  }

  private _recordEventFire(trig: PtyEvent, line: string, match: RegExpMatchArray): void {
    const fire: PtyEventFire = {
      id:
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `fire-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      ts: Date.now(),
      patternSource: trig.pattern.toString(),
      label: trig.label,
      line,
      match: Array.from(match).slice(0, 8) as string[],
      duringReplay: !this._replayDone,
    };
    this._eventFires.push(fire);
    while (this._eventFires.length > PtyConnection.MAX_EVENT_FIRES) {
      this._eventFires.shift();
    }
    for (const fn of this._eventFireListeners) {
      try {
        fn(fire);
      } catch (e) {
        console.error('[PtyConnection] event-fire listener error:', e);
      }
    }
  }

  // ── Event subscriptions (xterm interface) ─────────────────────────────────

  /**
   * Subscribe to live PTY output. Only fires after isReady.
   * Returns an unsubscribe function.
   */
  onOutput(fn: PtyOutputListener): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  /** Unsubscribe a live output listener (legacy compat). */
  offOutput(fn: PtyOutputListener): void {
    this._listeners.delete(fn);
  }

  /**
   * Subscribe to the "ready" event — fires every time replay completes
   * (including after reconnects). Fires immediately if already ready.
   * Returns an unsubscribe function.
   */
  onReady(fn: () => void): () => void {
    this._readyListeners.add(fn);
    // Fire immediately if replay is already done (mount of an existing terminal).
    if (this._replayDone) fn();
    return () => this._readyListeners.delete(fn);
  }

  /**
   * Subscribe to the "disconnect" event — fires when the WS drops.
   * Returns an unsubscribe function.
   */
  onDisconnect(fn: () => void): () => void {
    this._disconnectListeners.add(fn);
    return () => this._disconnectListeners.delete(fn);
  }

  // ── I/O (xterm interface) ─────────────────────────────────────────────────

  /** Send keystrokes to the backend PTY. */
  async sendInput(data: string): Promise<void> {
    if (!this.isLive) {
      console.warn('[PtyConnection] sendInput: PTY not live');
      return;
    }
    if (!this.computeNodeId) return;
    const { ActionInfo } = await import('../../models/index.js');
    const { dataManager } = await import('../../APIEntity.js');
    const action = new ActionInfo('terminal-command', 'compute_node', this.computeNodeId, 'POST');
    action.subpath = 'input';
    action.bodyParameters = { shell_id: this.shellId, data };
    try {
      await dataManager.callActionOverWS<any, any>(action);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('PTY session not found')) {
        this.started = false;
        this._replayDone = false;
        this._attachedPtyId = null;
        this._emitDisconnect();
      } else {
        throw e;
      }
    }
  }

  /** Notify the backend PTY of a terminal resize. */
  async resize(cols: number, rows: number): Promise<void> {
    if (!this.started) return;
    if (!this.computeNodeId) return;
    const { ActionInfo } = await import('../../models/index.js');
    const { dataManager } = await import('../../APIEntity.js');
    const action = new ActionInfo('terminal-command', 'compute_node', this.computeNodeId, 'POST');
    action.subpath = 'resize';
    action.bodyParameters = { shell_id: this.shellId, cols, rows };
    try {
      await dataManager.callActionOverWS<any, any>(action);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('PTY session not found') || msg.includes('Failed to resize PTY')) {
        this.started = false;
      }
    }
  }

  // ── Attach lifecycle (called by Shell) ────────────────────────────────────

  /**
   * Attach (or re-attach) to a backend PTY.
   * Idempotent and deduped — safe to call on every tab switch.
   */
  async attach(ptyId: string, opts: { force?: boolean; timeout?: number } = {}): Promise<void> {
    const { force = false, timeout } = opts;
    const targetPtyId = ptyId;

    if (!this.computeNodeId) return;

    if (force) this._doReset();

    if (this._attachPromise && this._attachingPtyId === targetPtyId && !force) {
      // Already attaching to this PTY — return the in-flight promise silently
      return this._attachPromise;
    }

    if (this.started && this._replayDone && this._attachedPtyId === targetPtyId && !force) {
      // Already attached and replay done — no-op
      return;
    }

    const attachWork = (async () => {
      if (this._attachedPtyId !== targetPtyId) {
        this.clear();
        this._replayDone = false;
      }
      if (this.lastSeq > 0) this.lastSeq = 0;

      const latestSeq = await this._reattach(targetPtyId, this.lastSeq, timeout);
      if (latestSeq === undefined) {
        this._replayDone = false;
        this._attachedPtyId = null;
        throw new Error(`PTY ${targetPtyId} not found for shell ${this.shellId}`);
      }

      // Drain replay: server streams pty_output_msg before the attach response
      // resolves. Poll until lastSeq catches up (or 2s deadline).
      if (latestSeq > 0 && this.lastSeq < latestSeq) {
        await new Promise<void>((resolve) => {
          const deadline = Date.now() + 2000;
          const check = () => {
            if (this.lastSeq >= latestSeq || Date.now() >= deadline) {
              resolve();
            } else {
              setTimeout(check, 5);
            }
          };
          setTimeout(check, 0);
        });
      }

      const _t0 = (typeof window !== 'undefined' ? window : globalThis) as Record<string, unknown>;
      if (_t0.__shellNavT0 !== undefined)
        console.log(
          `[PERF] +${(performance.now() - (_t0.__shellNavT0 as number)).toFixed(0)}ms PtyConnection.attach() replayDone=true (shell=${this.shellId.slice(0, 8)})`,
        );

      this._attachedPtyId = targetPtyId;
      this._replayDone = true;
      this._emitReady();
    })();

    this._attachingPtyId = targetPtyId;
    this._attachPromise = attachWork.finally(() => {
      if (this._attachPromise === attachWork) {
        this._attachPromise = null;
        this._attachingPtyId = null;
      }
    });
    return this._attachPromise;
  }

  /** Re-attach with force=true, using the currently attached PTY ID. */
  forceReconnect(): Promise<void> {
    const ptyId = this._attachedPtyId ?? this.shellId;
    return this.attach(ptyId, { force: true });
  }

  /**
   * Called by Shell when the WebSocket connection closes.
   * Signals disconnect without destroying chunk state (replay still valid).
   */
  handleWsClose(): void {
    if (this._replayDone || this.started) {
      this._replayDone = false;
      this._emitDisconnect();
    }
  }

  // ── Fast cross-platform PTY ping ──────────────────────────────────────────

  async testPty(): Promise<boolean> {
    if (!this.started || !this.computeNodeId || !this.shellId) return false;
    const { ActionInfo } = await import('../../models/index.js');
    const { dataManager } = await import('../../APIEntity.js');
    const action = new ActionInfo('terminal-command', 'compute_node', this.computeNodeId, 'POST');
    action.subpath = 'ping';
    action.bodyParameters = { shell_id: this.shellId };
    try {
      const result = await dataManager.callActionOverWS<any, any>(action);
      return result?.data?.alive === true;
    } catch {
      return false;
    }
  }

  // ── Orphan buffer flush (called after _reattach succeeds) ─────────────────

  flush(entries: OrphanEntry[]): void {
    for (const entry of entries) {
      this.appendOutput(entry.data, entry.seq, entry.timestamp_ms);
    }
  }

  // ── Housekeeping ──────────────────────────────────────────────────────────

  /** Clear chunk buffer and reset seq counter (does NOT reset attach state).
   *  Also drops the PTY-event fire buffer — fires from a prior PTY pid are
   *  stale once we re-attach to a fresh pid. */
  clear(): void {
    this.chunks.clear();
    this.lastSeq = 0;
    this._lineBuffer = '';
    this._eventFires.length = 0;
  }

  dispose(): void {
    this._listeners.clear();
    this._readyListeners.clear();
    this._disconnectListeners.clear();
    this._lineListeners.clear();
    this._triggers.clear();
    this._eventFireListeners.clear();
    this._eventFires.length = 0;
    this.chunks.clear();
    this._lineBuffer = '';
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private _emitReady(): void {
    for (const fn of this._readyListeners) {
      try {
        fn();
      } catch (e) {
        console.error('[PtyConnection] onReady listener error:', e);
      }
    }
  }

  private _emitDisconnect(): void {
    for (const fn of this._disconnectListeners) {
      try {
        fn();
      } catch (e) {
        console.error('[PtyConnection] onDisconnect listener error:', e);
      }
    }
  }

  /** Reset all attach state for a force re-attach. */
  private _doReset(): void {
    this.clear();
    this._replayDone = false;
    this._attachedPtyId = null;
    this._attachPromise = null;
    this._attachingPtyId = null;
    this._emitDisconnect();
  }

  private async _reattach(ptyId: string, sinceSeq = 0, timeout?: number): Promise<number | undefined> {
    if (!this.computeNodeId) return undefined;
    const { ActionInfo } = await import('../../models/index.js');
    const { dataManager } = await import('../../APIEntity.js');
    const { ConnectionManager } = await import('../../websocket.js');
    const connection_id = ConnectionManager.getInstance().id;
    const action = new ActionInfo('terminal-command', 'compute_node', this.computeNodeId, 'POST');
    action.subpath = 'attach';
    action.bodyParameters = { shell_id: this.shellId, pty_id: ptyId, since_seq: sinceSeq, connection_id };
    const result = await dataManager.callActionOverWS<any, any>(
      action,
      timeout !== undefined ? { timeout } : undefined,
    );

    if (result?.status === 'not_found') {
      this.started = false;
      return undefined;
    }

    this.started = true;

    // Flush any orphan chunks that arrived before attach() was called
    const { ptyOrphanBuffer } = await import('./ptyOrphanBuffer.js');
    ptyOrphanBuffer.flush(this.shellId, this);

    return result?.latest_seq;
  }
}
