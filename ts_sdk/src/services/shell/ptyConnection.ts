import type { OrphanEntry } from './ptyOrphanBuffer';
import type { OutputChunk } from '../../pty-sync/types.js';

export type PtyOutputListener = (data: string, seq?: number) => void;
export type PtyConnectionStatus = 'idle' | 'connecting' | 'live' | 'restarting' | 'closed';

export class PtyConnection {
  started = false;
  computeNodeId: string | null = null;
  shellId: string | null = null;
  lastSeq = 0;
  chunks: Map<number, OutputChunk> = new Map();
  restarting = false;
  private readonly decoder = new TextDecoder('utf-8', { fatal: false });
  private listeners = new Set<PtyOutputListener>();

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
    // Store OutputChunk for VirtualTerminal timestamp tracking
    if (seq !== undefined) {
      // Full redraw detected: CC sends \x1b[3J (clear scrollback) when rewriting
      // the entire screen. All previous chunks are obsolete — clear them to cap
      // memory usage at ~80KB (one redraw) instead of growing forever.
      if (this._containsClearScrollback(bytes)) {
        this.chunks.clear();
      }
      this.chunks.set(seq, { seq, data: bytes, timestamp: timestamp_ms ?? Date.now() });
    }
    for (const listener of this.listeners) {
      try { listener(decoded, seq); } catch (e) { console.error('[PtyConnection] listener error:', e); }
    }
    return decoded;
  }

  onOutput(fn: PtyOutputListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  offOutput(fn: PtyOutputListener): void {
    this.listeners.delete(fn);
  }

  flush(entries: OrphanEntry[]): void {
    for (const entry of entries) {
      this.appendOutput(entry.data, entry.seq, entry.timestamp_ms);
    }
  }

  get isLive(): boolean { return this.started && !this.restarting; }

  get status(): PtyConnectionStatus {
    if (!this.started) return this.restarting ? 'restarting' : 'idle';
    if (this.restarting) return 'restarting';
    return 'live';
  }

  /** Fast cross-platform check: is the backend PTY process still running? */
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

  /** Check if bytes contain ESC[3J (clear scrollback) — signals a full TUI redraw. */
  private _containsClearScrollback(bytes: Uint8Array): boolean {
    // \x1b[3J = [0x1b, 0x5b, 0x33, 0x4a]
    for (let i = 0; i <= bytes.length - 4; i++) {
      if (bytes[i] === 0x1b && bytes[i + 1] === 0x5b && bytes[i + 2] === 0x33 && bytes[i + 3] === 0x4a) {
        return true;
      }
    }
    return false;
  }

  dispose(): void {
    this.listeners.clear();
    this.chunks.clear();
  }
}
