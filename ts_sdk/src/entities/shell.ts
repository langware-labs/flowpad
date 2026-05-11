import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { isApiError } from '../ApiResponse';
import { dataContext } from '../FlowSync/context';
import { IEntity } from '../IEntity';
import { ActionInfo } from '../models';
import { DockPointerData } from '../models/DockPointer';
import { TypeId } from '../models/TypeId';
import { PtyConnection } from '../services/shell/ptyConnection';
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
  compute_node_uname?: string | null;
  project_id?: string | null;
  collaboration_room_id?: string | null;
  tab_order?: number;
  pty_rename?: boolean;
  user_renamed?: boolean;
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
  compute_node_uname: string | null = null;
  project_id: string | null = null;
  collaboration_room_id: string | null = null;
  tab_order: number = 0;
  pty_rename: boolean = true;
  user_renamed: boolean = false;
  claude_session_id: string | null = null;
  created_at: string | null = null;
  last_active_at: string | null = null;
  error_message: string | null = null;

  /**
   * The single PTY interface — always present, eagerly created.
   * All PTY lifecycle, I/O, and event logic lives here.
   */
  readonly ptyConnection: PtyConnection;

  /** True once this shell's tab has been the active tab at least once. */
  private _hasEverBeenActive = false;

  get dockPointer(): DockPointerData {
    return new DockPointerData(ViewType.SHELL, this.typeId?.toString());
  }

  get computeNodeTypeId(): TypeId | null {
    return this.compute_node_id ? new TypeId('compute_node', this.compute_node_id) : null;
  }

  get ptyRename(): boolean {
    return this.pty_rename;
  }

  set ptyRename(value: boolean) {
    this.pty_rename = value;
  }

  constructor(entity: Partial<IShell> = {}) {
    super(entity as IEntity);
    // Create PtyConnection eagerly — eliminates the secondary orphan buffer path.
    // compute_node_id may not be set yet; PtyConnection guards on empty string.
    this.ptyConnection = new PtyConnection((entity as any).id ?? '', (entity as any).compute_node_id ?? '');
    // Bridge PtyConnection events to Shell's EventEmitter so existing listeners
    // (shell.on('status', ...)) keep working during the migration to ptyConnection.
    this.ptyConnection.onReady(() => this.emit('status', 'connected'));
    this.ptyConnection.onDisconnect(() => this.emit('status', 'disconnected'));
    // Re-emit lines as a Shell-level event so consumers can use either
    // shell.onLine(fn) or shell.on('line', fn) interchangeably.
    this.ptyConnection.onLine((line) => this.emit('line', line));
    // Re-apply entity data after class field initializers.
    Object.assign(this, entity);
    // Keep PtyConnection IDs in sync after Object.assign potentially sets them.
    if (this.id) this.ptyConnection.shellId = this.id;
    if (this.compute_node_id) this.ptyConnection.computeNodeId = this.compute_node_id;
  }

  // ── Status accessors ──────────────────────────────────────────────────────

  /** True when the PTY is live (WS up + started). Matches original shell.connected semantics. */
  get connected(): boolean {
    return this.ptyConnection.isLive;
  }

  /** True once attach() has finished its replay phase (no WS dependency). */
  get replayDone(): boolean {
    return this.ptyConnection.replayDone;
  }

  /** True if the PTY process has been started on the compute node. */
  get ptyStarted(): boolean {
    return this.ptyConnection.started;
  }

  get shellStatus(): string {
    if (this.status === ShellStatus.ERROR) return this.error_message ?? 'Shell error';
    if (this.status === ShellStatus.CLOSING) return 'Shell closing...';
    if (this.status === ShellStatus.CLOSED) return 'Shell closed';
    if (this.ptyConnection.restarting) return 'Restarting...';
    if (!this.ptyConnection.started) return 'Not connected';
    if (!this.ptyConnection.isLive) return 'Disconnected';
    return 'Live';
  }

  // ── Output routing ────────────────────────────────────────────────────────

  /**
   * Route a `pty_output_msg` from DataManager to the PtyConnection.
   * PtyConnection is always present so no orphan buffer needed here.
   */
  routePtyOutput(data: string, seq?: number, timestamp_ms?: number): string | null {
    // Keep PtyConnection IDs current in case they were set after construction
    // (e.g. Shell.list() uses Object.assign after new Shell()).
    if (this.id) this.ptyConnection.shellId = this.id;
    if (this.compute_node_id) this.ptyConnection.computeNodeId = this.compute_node_id;
    return this.ptyConnection.routeOutput(data, seq, timestamp_ms);
  }

  // ── Public PTY accessors (delegation wrappers — kept for caller compat) ───

  /** Sorted output chunks for VirtualTerminal rebuild on resize. */
  getPtyChunks(): import('../pty-sync/types.js').OutputChunk[] {
    return this.ptyConnection.getSortedChunks();
  }

  /** Single chunk by seq — for ptySyncRef.processChunk() in output handler. */
  getPtyChunk(seq: number): import('../pty-sync/types.js').OutputChunk | undefined {
    return this.ptyConnection.getChunk(seq);
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
   * Subscribe to PTY output.
   * Gated: returns undefined if not yet ready (replay not done).
   */
  onOutput(fn: import('../services/shell/ptyConnection.js').PtyOutputListener): (() => void) | undefined {
    if (!this.ptyConnection.replayDone) return undefined;
    return this.ptyConnection.onOutput(fn);
  }

  /**
   * Subscribe to ANSI-stripped output lines. Fires for every \n in the
   * stream, replayed chunks included. Use this for live pattern detection
   * over terminal output.
   *
   * Also re-emits as a `line` event on this Shell — callers can use
   * `shell.on('line', fn)` interchangeably.
   */
  onLine(fn: import('../services/shell/ptyConnection.js').PtyLineListener): () => void {
    return this.ptyConnection.onLine(fn);
  }

  /**
   * Register a regex trigger over the line stream. ``onMatch`` fires with
   * the matched line and the regex match. Pattern is tested against
   * already-ANSI-stripped lines.
   */
  addTrigger(trigger: import('../services/shell/ptyConnection.js').PtyEvent): () => void {
    return this.ptyConnection.addTrigger(trigger);
  }

  /** Snapshot of recorded PtyEvent fires on this shell's PTY connection. */
  getPtyEventFires(): readonly import('../services/shell/ptyConnection.js').PtyEventFire[] {
    return this.ptyConnection.getEventFires();
  }

  /** Subscribe to new PtyEvent fires. Returns an unsubscribe function. */
  onPtyEventFire(
    fn: import('../services/shell/ptyConnection.js').PtyEventFireListener,
  ): () => void {
    return this.ptyConnection.onEventFire(fn);
  }

  /** Number of currently-registered PtyEvent watchers on this shell. */
  getRegisteredPtyEventCount(): number {
    return this.ptyConnection.getRegisteredEventCount();
  }

  // ── Shell start (backend HTTP + PTY attach) ───────────────────────────────

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
    // Sync IDs into PtyConnection (compute_node_id may have been set by backend response).
    if (this.compute_node_id) this.ptyConnection.computeNodeId = this.compute_node_id;
    this.ptyConnection.shellId = this.id;
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
   */
  async attachPty(opts: IShellConnectionOptions): Promise<void> {
    const { isActive = true, ptyId, force = false, timeout } = opts;
    const targetPtyId = ptyId ?? this.pty_pid ?? this.id;

    if (isActive) this._hasEverBeenActive = true;
    if (!this._hasEverBeenActive) return; // still deferred

    if (!_shellRegistry.has(this)) {
      _shellRegistry.add(this);
      _ensureStaticListeners();
    }

    // Sync computeNodeId in case it was set after construction.
    if (this.compute_node_id) this.ptyConnection.computeNodeId = this.compute_node_id;
    this.ptyConnection.shellId = this.id;

    await this.ptyConnection.attach(targetPtyId, { force, timeout });
  }

  // ── I/O delegation wrappers ───────────────────────────────────────────────

  async sendInput(data: string): Promise<void> {
    return this.ptyConnection.sendInput(data);
  }

  async resize(cols: number, rows: number): Promise<void> {
    return this.ptyConnection.resize(cols, rows);
  }

  // ── WS lifecycle handlers ─────────────────────────────────────────────────

  /** Called by the static on_close dispatcher. */
  _onCmClose(): void {
    this.ptyConnection.handleWsClose();
  }

  /** Called by the static on_reconnected dispatcher. */
  _onCmReconnected(): void {
    if (this.status === ShellStatus.ERROR) return;
    if (!this._hasEverBeenActive) return;
    const workdir = this.workdir ?? dataContext.project?.fs_storage_mount_path ?? undefined;
    // Owned-shell guard: shells owned by an AgenticProcess have their
    // recovery driven at the process layer (it knows session_id, --resume,
    // env injection). Bare ``Shell.start`` would just spawn an empty PTY
    // that the agentic-process open then has to drop. Lazy import keeps the
    // existing module-dependency direction (agentic-process imports Shell).
    void import('../process/agentic-process').then(({ _isShellOwnedByAgenticProcess }) => {
      if (_isShellOwnedByAgenticProcess(this.id)) return;
      void this.start({ cols: 80, rows: 24, workdir });
    });
  }

  // ── Entity lifecycle ──────────────────────────────────────────────────────

  async close(): Promise<void> {
    _shellRegistry.delete(this);
    const previousStatus = this.status;
    this.status = ShellStatus.CLOSING;
    const action = new ActionInfo('close', Shell.type, this.id, 'POST');
    try {
      await dataManager.callAction<any, any>(action);
      this.ptyConnection.dispose();
      this.status = ShellStatus.CLOSED;
    } catch (error) {
      // 404 means the shell entity is already gone — treat as already closed
      if (isApiError(error) && error.response?.status === 404) {
        this.ptyConnection.dispose();
        this.status = ShellStatus.CLOSED;
        dataManager.removeEntityFromCache(this.typeId);
        return;
      }
      this.status = previousStatus;
      throw error;
    }
  }

  async updateDisplay(fields: {
    name?: string;
    tab_order?: number;
    is_pty?: boolean;
    pty_rename?: boolean;
    ptyRename?: boolean;
  }): Promise<Shell> {
    const action = new ActionInfo('update-display', Shell.type, this.id, 'POST');
    action.bodyParameters = fields;
    const result = await dataManager.callAction<any, Partial<IShell>>(action);
    Object.assign(this, result ?? fields);
    dataManager.notifyEntityChanged(this);
    return this;
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
    computeNode: { id: string; uname?: string | null; typeId?: any },
    opts?: { name?: string; workdir?: string; tab_order?: number },
  ): Shell {
    return new Shell({
      compute_node_id: computeNode.id,
      compute_node_uname: computeNode.uname ?? null,
      status: ShellStatus.IDLE,
      ...opts,
    });
  }

  static async newLiveShell(opts?: { name?: string; workdir?: string; cols?: number; rows?: number }): Promise<Shell> {
    const computeNodeId = dataContext.computeNode?.id;
    if (!computeNodeId) throw new Error('[Shell.newLiveShell] No compute node');
    const shell = new Shell({
      name: opts?.name ?? 'shell',
      workdir: opts?.workdir,
      compute_node_id: computeNodeId,
      compute_node_uname: dataContext.computeNode?.uname ?? null,
    });
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
        const id = (d as any)?.id;
        // Prefer the cached instance — constructing `new Shell(d)` registers
        // in the DataManager cache and orphans any previous instance, breaking
        // existing subscribers (InteractiveTerminal's onOutput would keep firing
        // on the orphaned instance while PTY routing hits the new one). Merge
        // fresh fields into the cached instance instead.
        if (id) {
          const existing = Shell.getByIdFromCache(id);
          if (existing) {
            Object.assign(existing, d);
            results.push(existing);
            continue;
          }
        }
        results.push(new Shell(d));
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
