import type { OrphanEntry } from './ptyOrphanBuffer';
import type { OutputChunk } from '../../pty-sync/types.js';
import { dataContext } from '../../FlowSync/context';

export type PtyOutputListener = (data: string, seq?: number) => void;
export type PtyConnectionStatus = 'idle' | 'connecting' | 'live' | 'restarting' | 'closed';

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
    // Only fire live listeners after replay phase is complete.
    // Gate on _replayDone only (not isLive) so unit tests work without a WS.
    if (this._replayDone) {
      for (const listener of this._listeners) {
        try { listener(decoded, seq); } catch (e) { console.error('[PtyConnection] listener error:', e); }
      }
    }
    return decoded;
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

  /** Clear chunk buffer and reset seq counter (does NOT reset attach state). */
  clear(): void {
    this.chunks.clear();
    this.lastSeq = 0;
  }

  dispose(): void {
    this._listeners.clear();
    this._readyListeners.clear();
    this._disconnectListeners.clear();
    this.chunks.clear();
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private _emitReady(): void {
    for (const fn of this._readyListeners) {
      try { fn(); } catch (e) { console.error('[PtyConnection] onReady listener error:', e); }
    }
  }

  private _emitDisconnect(): void {
    for (const fn of this._disconnectListeners) {
      try { fn(); } catch (e) { console.error('[PtyConnection] onDisconnect listener error:', e); }
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
