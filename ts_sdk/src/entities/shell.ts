import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { isApiError } from '../ApiResponse';
import { dataContext } from '../FlowSync/context';
import { IEntity } from '../IEntity';
import { ActionInfo } from '../models';
import { DockPointerData } from '../models/DockPointer';
import { PtyConnection } from '../services/shell/ptyConnection';
import { ptyOrphanBuffer } from '../services/shell/ptyOrphanBuffer';
import { ViewType } from '../utils/ui/view-types';

export const ShellStatus = {
  IDLE: 'idle',
  RUNNING: 'running',
  CLOSING: 'closing',
  CLOSED: 'closed',
  ERROR: 'error',
} as const;

export type ShellStatus = (typeof ShellStatus)[keyof typeof ShellStatus];

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface PtySequenceChunkMeta {
  seq: number;
  timestamp: number;
  size: number;
  data_b64: string;
  preview_b64: string;
}

export interface PtySequenceData {
  chunks: PtySequenceChunkMeta[];
  total_chunks: number;
  total_size_bytes: number;
  next_seq: number;
  pty_file_b64: string | null;
}

export interface IShellConnectionOptions {
  cols: number;
  rows: number;
  isActive?: boolean; // deferred activation gate (default: true)
  workdir?: string;
  ptyId?: string;
  force?: boolean; // reset seq + replayDone and re-attach (absorbs restart())
  timeout?: number; // WS request timeout ms (default: 30 000)
}

export interface IShellStartOptions {
  cols?: number;
  rows?: number;
  workdir?: string;
  timeout?: number;
}

export interface IShell extends IEntity {
  name?: string | null;
  status?: string;
  workdir?: string | null;
  pty_pid?: string | null;
  compute_node_id?: string | null;
  project_id?: string | null;
  tab_order?: number;
  claude_session_id?: string | null;
  created_at?: string | null;
  last_active_at?: string | null;
  env?: Record<string, string> | null;
}

// ---------------------------------------------------------------------------
// Static dispatch registry — a single on_close + on_reconnected listener pair
// on ConnectionManager routes events to all live Shell instances. This keeps
// the EventEmitter listener count constant regardless of how many shells exist.
// ---------------------------------------------------------------------------
const _shellRegistry = new Set<Shell>();
let _staticListenersRegistered = false;

function _ensureStaticListeners(): void {
  if (_staticListenersRegistered) return;
  _staticListenersRegistered = true;
  void import('../websocket').then(({ ConnectionManager }) => {
    const cm = ConnectionManager.getInstance();
    cm.on('on_close', () => {
      for (const shell of _shellRegistry) shell._onCmClose();
    });
    cm.on('on_reconnected', () => {
      for (const shell of _shellRegistry) shell._onCmReconnected();
    });
  });
}

@registerEntity
export class Shell extends APIEntity<Shell> implements IShell {
  static type: string = 'shell';
  static DEFAULT_COLS = 80;
  static DEFAULT_ROWS = 24;

  name: string | null = null;
  status: string = ShellStatus.IDLE;
  workdir: string | null = null;
  env: Record<string, string> | null = null;
  pty_pid: string | null = null;
  compute_node_id: string | null = null;
  project_id: string | null = null;
  tab_order: number = 0;
  claude_session_id: string | null = null;
  created_at: string | null = null;
  last_active_at: string | null = null;
  error_message: string | null = null;

  /** Transient PTY connection state — not persisted, not part of IShell */
  private _pty: PtyConnection | null = null;

  /** True once this shell's tab has been the active tab at least once. */
  private _hasEverBeenActive = false;

  /** True once attachPty() has finished its replay phase and the output gate is open. */
  private _replayDone = false;

  /** Backend-owned PTY handle currently attached in this browser client. */
  private _attachedPtyId: string | null = null;

  /** In-flight attach dedupe guard. */
  private _attachPromise: Promise<void> | null = null;

  /** PTY currently being attached. */
  private _attachingPtyId: string | null = null;

  get dockPointer(): DockPointerData {
    return new DockPointerData(ViewType.SHELL, this.typeId?.toString());
  }

  constructor(entity: Partial<IShell> = {}) {
    super(entity as IEntity);
    // Re-apply entity data after class field initializers (which run after super())
    // would otherwise overwrite values set by deepAssign() in APIEntity.
    Object.assign(this, entity);
  }

  get connected(): boolean {
    return this._pty?.isLive ?? false;
  }

  /** True once attachPty() has finished its replay phase and the output gate is open. */
  get replayDone(): boolean {
    return this._replayDone;
  }

  /** True if the PTY process has been started on the compute node. */
  get ptyStarted(): boolean {
    return this._pty?.started ?? false;
  }

  get shellStatus(): string {
    if (this.status === ShellStatus.ERROR) return this.error_message ?? 'Shell error';
    if (this.status === ShellStatus.CLOSING) return 'Shell closing...';
    if (this.status === ShellStatus.CLOSED) return 'Shell closed';
    if (!this._pty) return 'Not connected';
    if (this._pty.restarting) return 'Restarting...';
    if (!this._pty.started) return 'Connecting...';
    if (!this._pty.isLive) return 'Disconnected';
    return 'Live';
  }

  // ── Private PTY state accessors ───────────────────────────────────────────

  /** Seq of last received chunk; used by connect() for replay offset. */
  private get _lastPtySeq(): number {
    return this._pty?.lastSeq ?? 0;
  }

  /** Force-reset seq to 0 so connect() requests a full replay. */
  private _resetPtySeq(): void {
    if (this._pty) this._pty.lastSeq = 0;
  }

  // ── Public accessors ──────────────────────────────────────────────────────

  /**
   * Route a `pty_output_msg` from the store to the active PtyConnection.
   * Called by DataManager.onPtyOutputMessage(); buffers to ptyOrphanBuffer if
   * _pty is not yet initialized.
   */
  routePtyOutput(data: string, seq?: number, timestamp_ms?: number): string | null {
    if (!this._pty) {
      ptyOrphanBuffer.buffer(this.id, data, seq, timestamp_ms);
      return null;
    }
    return this._pty.appendOutput(data, seq, timestamp_ms);
  }

  /** Sorted output chunks for VirtualTerminal rebuild on resize. */
  getPtyChunks(): import('../pty-sync/types.js').OutputChunk[] {
    if (!this._pty) return [];
    return [...this._pty.chunks.values()].sort((a, b) => a.seq - b.seq);
  }

  /** Single chunk by seq — for ptySyncRef.processChunk() in output handler. */
  getPtyChunk(seq: number): import('../pty-sync/types.js').OutputChunk | undefined {
    return this._pty?.chunks.get(seq);
  }

  printPty(): void {
    const dec = new TextDecoder();
    console.log(
      this.getPtyChunks()
        .map((c) => dec.decode(c.data))
        .join(''),
    );
  }

  /**
   * Subscribe to PTY output. Returns an unsubscribe function, or undefined if
   * the connection is not ready (replayDone is false). Gating here ensures that
   * no external subscriber can receive replay chunks — those are delivered via
   * getPtyChunks() after connect() completes.
   */
  onOutput(fn: import('../services/shell/ptyConnection.js').PtyOutputListener): (() => void) | undefined {
    if (!this._replayDone) return undefined;
    return this._pty?.onOutput(fn);
  }

  /**
   * Backend-owned shell start. The frontend only opens the shell and then
   * attaches to the PTY handle returned by the backend.
   */
  async start(opts: IShellStartOptions = {}): Promise<string> {
    const cols = opts.cols ?? Shell.DEFAULT_COLS;
    const rows = opts.rows ?? Shell.DEFAULT_ROWS;
    const workdir = opts.workdir ?? this.workdir ?? undefined;
    const { ConnectionManager } = await import('../websocket');
    const connection_id = ConnectionManager.getInstance().id;
    const action = new ActionInfo('open', Shell.type, this.id, 'POST');
    action.bodyParameters = { connection_id, cols, rows, ...(workdir ? { working_dir: workdir } : {}) };
    const result = await dataManager.callAction<any, Record<string, unknown> | null>(action);
    if (!result) throw new Error(`Shell ${this.id} could not be opened`);
    Object.assign(this, result);
    this.pty_pid = (result.pty_id as string | undefined) ?? (result.pty_pid as string | undefined) ?? this.id;
    if (workdir !== undefined) this.workdir = workdir;
    await this.attachPty({ cols, rows, workdir, timeout: opts.timeout, ptyId: this.pty_pid ?? this.id });
    return this.pty_pid ?? this.id;
  }

  // ── PTY lifecycle entry point ─────────────────────────────────────────────

  /**
   * Single PTY lifecycle entry point. Deferred until the tab is first activated.
   *
   * Options:
   *   - isActive: deferred activation gate (default: true)
   *   - force: reset seq + replayDone before connecting (absorbs old restart())
   *
   * Replay chunks arrive during _reattach() and are stored in _pty.chunks via
   * appendOutput(). No external onOutput() subscriber can exist at this point —
   * onOutput() gates on replayDone. After reattach + ensurePty,
   * _bump({ replayDone: true }) signals React to read getPtyChunks() for the
   * replay write, then subscribe onOutput() for live output.
   */
  async attachPty(opts: IShellConnectionOptions): Promise<void> {
    const { cols, rows, isActive = true, ptyId, force = false, timeout } = opts;
    const targetPtyId = ptyId ?? this.pty_pid ?? this.id;

    if (isActive) this._hasEverBeenActive = true;
    if (!this._hasEverBeenActive) return; // still deferred

    if (!_shellRegistry.has(this)) {
      _shellRegistry.add(this);
      _ensureStaticListeners();
    }

    if (force) this._restart();

    if (this._attachPromise && this._attachingPtyId === targetPtyId && !force) {
      console.warn(`[Shell] duplicate attach ignored while attach is in flight (shell=${this.id}, pty_id=${targetPtyId})`);
      return this._attachPromise;
    }

    if (this._pty?.started && this._replayDone && this._attachedPtyId === targetPtyId && !force) {
      console.warn(`[Shell] duplicate attach ignored (shell=${this.id}, pty_id=${targetPtyId})`);
      return;
    }

    if (!this.compute_node_id) return;

    const attachWork = (async () => {
      if (this._attachedPtyId !== targetPtyId) {
        if (this._pty) this._pty.clear();
        this._replayDone = false;
      }
      if (this._lastPtySeq > 0) this._resetPtySeq();
      if (!this._pty) this._pty = new PtyConnection();

      // _reattach() sends replay WS messages → appendOutput() stores each chunk
      // in _pty.chunks — no external subscriber exists yet (onOutput() is gated)
      const latestSeq = await this._reattach(targetPtyId, this._lastPtySeq, timeout);
      if (latestSeq === undefined) {
        this._replayDone = false;
        this._attachedPtyId = null;
        throw new Error(`PTY ${targetPtyId} not found for shell ${this.id}`);
      }

      // Drain replay: the server streams pty_output_msg messages before the
      // attach response, but they may arrive as separate macrotasks that haven't
      // been processed yet when _reattach() resolves. Poll until _pty.lastSeq
      // reaches latestSeq (or the deadline) before signaling replayDone.
      if (latestSeq > 0 && this._pty.lastSeq < latestSeq) {
        await new Promise<void>((resolve) => {
          const deadline = Date.now() + 2000;
          const check = () => {
            if (this._pty!.lastSeq >= latestSeq || Date.now() >= deadline) {
              resolve();
            } else {
              setTimeout(check, 5);
            }
          };
          setTimeout(check, 0); // yield one macrotask so pending WS messages can be processed
        });
      }

      // ONLY NOW flip replayDone — InteractiveTerminal's 'connected' event handler
      // resets xterm, writes getPtyChunks() for the replay, and subscribes onOutput().
      const _t0 = (typeof window !== 'undefined' ? window : globalThis) as Record<string, unknown>;
      if (_t0.__shellNavT0 !== undefined)
        console.log(
          `[PERF] +${(performance.now() - (_t0.__shellNavT0 as number)).toFixed(0)}ms shell.attachPty() replayDone=true (shell=${this.id.slice(0, 8)})`,
        );
      this._attachedPtyId = targetPtyId;
      this._replayDone = true;
      this.emit('status', 'connected');
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

  // ── Private PTY lifecycle ─────────────────────────────────────────────────

  /** Reset local PTY attach state so the next attach performs a full replay. */
  private _restart(): void {
    this._pty?.clear();
    this._replayDone = false;
    this._attachedPtyId = null;
    this._attachPromise = null;
    this._attachingPtyId = null;
    this.emit('status', 'disconnected');
  }

  private async _reattach(ptyId: string, sinceSeq = 0, timeout?: number): Promise<number | undefined> {
    if (!this.compute_node_id) return;
    if (!this._pty) this._pty = new PtyConnection();
    this._pty.computeNodeId = this.compute_node_id;
    this._pty.shellId = this.id;
    const { ConnectionManager } = await import('../websocket');
    const connection_id = ConnectionManager.getInstance().id;
    const action = new ActionInfo('terminal-command', 'compute_node', this.compute_node_id, 'POST');
    action.subpath = 'attach';
    action.bodyParameters = { shell_id: this.id, pty_id: ptyId, since_seq: sinceSeq, connection_id };
    const result = await dataManager.callActionOverWS<any, any>(
      action,
      timeout !== undefined ? { timeout } : undefined,
    );

    // Server returns status="not_found" when the PTY session no longer exists
    if (result?.status === 'not_found') {
      this._pty.started = false;
      return undefined;
    }

    this._pty.started = true;
    ptyOrphanBuffer.flush(this.id, this._pty);
    return result?.latest_seq;
  }

  // ── Public I/O and display methods ───────────────────────────────────────

  async sendInput(data: string): Promise<void> {
    if (!this._pty?.isLive) {
      console.warn('[Shell] sendInput: PTY not live');
      return;
    }
    if (!this.compute_node_id) return;
    const action = new ActionInfo('terminal-command', 'compute_node', this.compute_node_id, 'POST');
    action.subpath = 'input';
    action.bodyParameters = { shell_id: this.id, data };
    try {
      await dataManager.callActionOverWS<any, any>(action);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('PTY session not found')) {
        if (this._pty) this._pty.started = false;
        this._replayDone = false;
        this._attachedPtyId = null;
      } else {
        throw e;
      }
    }
  }

  async resize(cols: number, rows: number): Promise<void> {
    if (!this._pty?.started) return;
    if (!this.compute_node_id) return;
    const action = new ActionInfo('terminal-command', 'compute_node', this.compute_node_id, 'POST');
    action.subpath = 'resize';
    action.bodyParameters = { shell_id: this.id, cols, rows };
    try {
      await dataManager.callActionOverWS<any, any>(action);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('PTY session not found') || msg.includes('Failed to resize PTY')) {
        if (this._pty) this._pty.started = false;
      }
    }
  }

  /** Called by the static on_close dispatcher. */
  _onCmClose(): void {
    if (this._replayDone || this._pty?.started) {
      this._replayDone = false;
      this.emit('status', 'disconnected');
    }
  }

  /** Called by the static on_reconnected dispatcher. */
  _onCmReconnected(): void {
    if (this.status === ShellStatus.ERROR) return;
    if (!this._hasEverBeenActive) return;
    const workdir = this.workdir ?? dataContext.project?.fs_storage_mount_path ?? undefined;
    void this.start({ cols: 80, rows: 24, workdir });
  }

  async close(): Promise<void> {
    _shellRegistry.delete(this);
    const previousStatus = this.status;
    this.status = ShellStatus.CLOSING;
    const action = new ActionInfo('close', Shell.type, this.id, 'POST');
    try {
      await dataManager.callAction<any, any>(action);
      this._pty?.dispose();
      this._pty = null;
      this.status = ShellStatus.CLOSED;
    } catch (error) {
      // 404 means the shell entity is already gone — treat as already closed
      if (isApiError(error) && error.response?.status === 404) {
        this._pty?.dispose();
        this._pty = null;
        this.status = ShellStatus.CLOSED;
        dataManager.removeEntityFromCache(this.typeId);
        return;
      }
      this.status = previousStatus;
      throw error;
    }
  }

  async updateDisplay(fields: { name?: string; tab_order?: number }): Promise<void> {
    const action = new ActionInfo('update-display', Shell.type, this.id, 'POST');
    action.bodyParameters = fields;
    await dataManager.callAction<any, any>(action);
    Object.assign(this, fields);
    // Notify watchers so React components that subscribe to Shell entities re-render
    // with the updated display properties (name, tab_order).
    dataManager.notifyEntityChanged(this);
  }

  async run(command: string): Promise<ShellResult> {
    const action = new ActionInfo('run', Shell.type, this.id, 'POST');
    action.bodyParameters = { command };
    const result = await dataManager.callAction<any, any>(action);
    return {
      stdout: result?.stdout ?? '',
      stderr: result?.stderr ?? '',
      exitCode: result?.exit_code ?? -1,
    };
  }

  async setEnv(vars: Record<string, string>): Promise<void> {
    const action = new ActionInfo('set-env', Shell.type, this.id, 'POST');
    action.bodyParameters = { vars };
    await dataManager.callAction<any, any>(action);
  }

  async fetchPtySequence(): Promise<PtySequenceData> {
    const action = new ActionInfo('fetch-pty-sequence', Shell.type, this.id, 'GET');
    const result = await dataManager.callAction<undefined, PtySequenceData>(action);
    return result;
  }

  // ── Static helpers ────────────────────────────────────────────────────────

  static create(
    computeNode: { id: string; typeId?: any },
    opts?: { name?: string; workdir?: string; tab_order?: number },
  ): Shell {
    return new Shell({
      compute_node_id: computeNode.id,
      status: ShellStatus.IDLE,
      ...opts,
    });
  }

  static async newLiveShell(opts?: { name?: string; workdir?: string; cols?: number; rows?: number }): Promise<Shell> {
    const computeNodeId = dataContext.computeNode?.id;
    if (!computeNodeId) throw new Error('[Shell.newLiveShell] No compute node');
    const shell = new Shell({ name: opts?.name ?? 'shell', workdir: opts?.workdir, compute_node_id: computeNodeId });
    await shell.save();
    await shell.start({ cols: opts?.cols ?? 80, rows: opts?.rows ?? 24, workdir: opts?.workdir });
    return shell;
  }

  static async list(computeNodeId: string): Promise<Shell[]> {
    const { ComputeNode: ComputeNodeClass } = await import('./compute-node/compute-node');
    const action = new ActionInfo('list-shells', ComputeNodeClass.type, computeNodeId, 'GET');
    const response = await dataManager.callAction<any, any>(action);
    const data = Array.isArray(response) ? response : response?.data || [];
    const results: Shell[] = [];
    for (const d of data) {
      try {
        // Use Object.assign after construction so class field initializers
        // (e.g. status: string = 'idle') don't overwrite values from the API.
        results.push(Object.assign(new Shell(), d));
      } catch {
        // skip entries with invalid IDs (e.g. non-UUID legacy records)
      }
    }
    return results;
  }

  static async getActiveSessions(): Promise<Shell[]> {
    const all = await Shell.query<Shell>({});
    return all.filter((s) => s.status !== ShellStatus.CLOSED).sort((a, b) => (a.tab_order ?? 0) - (b.tab_order ?? 0));
  }
}
