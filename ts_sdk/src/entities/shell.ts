import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { isApiError } from '../ApiResponse';
import { dataContext } from '../FlowSync/context';
import { QueryRequest } from '../FlowSync/query';
import { IEntity, EntityMerge } from '../IEntity';
import { ActionInfo } from '../models';
import { TargetedDock } from '../models/DockPointer';
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

export interface IShellConnectionOptions {
  /** When provided, attach asserts this size on the PTY (real xterm size only —
   *  loader-time callers omit them so a live PTY isn't shrunk to defaults). */
  cols?: number;
  rows?: number;
  isActive?: boolean; // deferred activation gate (default: true)
  workdir?: string;
  ptyId?: string;
  force?: boolean; // reset attach state and re-attach (absorbs restart())
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
  /** Owning AgenticProcess id — reverse of AgenticProcess.shell_id. Set once
   *  at shell creation; lets a bare-shell URL resolve its owner by get-by-id.
   *  NB: distinct from the OS PID (which the PTY layer writes as `process_id`). */
  agentic_process_id?: string | null;
  /** tab_order / last_active_at come from IEntity (base-Entity fields). */
  auto_rename?: boolean;
  claude_session_id?: string | null;
  created_at?: string | null;
  env?: Record<string, string> | null;
}

// Connection membership is backend-owned (PtyRegistry.on_ws_connect/on_ws_disconnect
// park & resume on the WS lifecycle). The frontend no longer re-attaches on
// reconnect or tears down the PTY pipeline on a transient WS drop — the renderer
// stays armed and resumes when the backend resumes delivery. See
// InteractiveTerminal's on_reconnected handler for the gap-replay repaint.

/**
 * Declaration merge: `implements IShell` only CHECKS the class, it adds no
 * members — so every field declared solely on IShell read as "does not exist
 * on type Shell", even though `deepAssign` populates them from the wire.
 * This interface makes them part of the class type.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Shell extends EntityMerge<IShell> {}

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
  agentic_process_id: string | null = null;
  /** Every live pure shell is a strip tab (backend default-True override). */
  tabbed: boolean = true;
  tab_order: number = 0;
  auto_rename: boolean = true;
  claude_session_id: string | null = null;
  created_at: string | null = null;
  /** Epoch-ms (base-Entity field); legacy rows may deliver an ISO string. */
  last_active_at: number | string | null = null;
  error_message: string | null = null;

  /**
   * The single PTY interface — always present, eagerly created.
   * All PTY lifecycle, I/O, and event logic lives here.
   */
  readonly ptyConnection: PtyConnection;

  /** True once this shell's tab has been the active tab at least once. */
  private _hasEverBeenActive = false;

  get dockPointer(): TargetedDock {
    return new TargetedDock(ViewType.SHELL, this.typeId.toString());
  }

  get computeNodeTypeId(): TypeId | null {
    return this.compute_node_id ? new TypeId('compute_node', this.compute_node_id) : null;
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

  /** True once attach() has completed (no WS dependency). */
  get attached(): boolean {
    return this.ptyConnection.attached;
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
   * Gated: returns undefined if the PTY is not yet attached.
   */
  onOutput(fn: import('../services/shell/ptyConnection.js').PtyOutputListener): (() => void) | undefined {
    if (!this.ptyConnection.attached) return undefined;
    return this.ptyConnection.onOutput(fn);
  }

  /**
   * Subscribe to ANSI-stripped output rows. Fires for LF-delimited lines and
   * bare-CR terminal redraw rows, replayed chunks included. Use this for live
   * pattern detection over terminal output.
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
    const result = await this.post<Record<string, unknown> | null>('open', { connection_id, cols, rows, ...(workdir ? { working_dir: workdir } : {}) });
    if (!result) throw new Error(`Shell ${this.id} could not be opened`);
    Object.assign(this, result);
    this.pty_pid = (result.pty_id as string | undefined) ?? (result.pty_pid as string | undefined) ?? this.id;
    if (workdir !== undefined) this.workdir = workdir;
    // Sync IDs into PtyConnection (compute_node_id may have been set by backend response).
    if (this.compute_node_id) this.ptyConnection.computeNodeId = this.compute_node_id;
    this.ptyConnection.shellId = this.id;
    // No cols/rows: open() already sized a NEW pty; for an existing pty the
    // defaults here are not the client's real xterm size — attach jiggles at
    // the current size and the mount-time fit()/resize() asserts the real one.
    await this.attachPty({ workdir, timeout: opts.timeout, ptyId: this.pty_pid ?? this.id });
    return this.pty_pid ?? this.id;
  }

  // ── PTY lifecycle entry point ─────────────────────────────────────────────

  /**
   * Single PTY lifecycle entry point. Deferred until the tab is first activated.
   *
   * Options:
   *   - isActive: deferred activation gate (default: true)
   *   - force: reset attach state before connecting (absorbs old restart())
   */
  async attachPty(opts: IShellConnectionOptions): Promise<void> {
    const { isActive = true, ptyId, force = false, timeout, cols, rows } = opts;
    const targetPtyId = ptyId ?? this.pty_pid ?? this.id;

    if (isActive) this._hasEverBeenActive = true;
    if (!this._hasEverBeenActive) return; // still deferred

    // Sync computeNodeId in case it was set after construction.
    if (this.compute_node_id) this.ptyConnection.computeNodeId = this.compute_node_id;
    this.ptyConnection.shellId = this.id;

    await this.ptyConnection.attach(targetPtyId, { force, timeout, cols, rows });
  }

  // ── I/O delegation wrappers ───────────────────────────────────────────────

  async sendInput(data: string): Promise<void> {
    return this.ptyConnection.sendInput(data);
  }

  async resize(cols: number, rows: number): Promise<void> {
    return this.ptyConnection.resize(cols, rows);
  }

  // ── Entity lifecycle ──────────────────────────────────────────────────────

  async close(): Promise<void> {
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

  async run(command: string): Promise<ShellResult> {
    const result = await this.post<any>('run', { command });
    return {
      stdout: result?.stdout ?? '',
      stderr: result?.stderr ?? '',
      exitCode: result?.exit_code ?? -1,
    };
  }

  async setEnv(vars: Record<string, string>): Promise<void> {
    const result = await this.post<any>('set-env', { vars });
    // Apply the server's merged env locally (same convention as `open()`), so a
    // read of `this.env` right after the await is correct without racing the
    // `data_op_msg` WS delivery that would otherwise be the only writer.
    if (result?.env) this.env = result.env as Record<string, string>;
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
    // Spelled out rather than `{}`: `query` overrides `type` and reuses the
    // request's `name`, so this is the exact request the old bare-object call
    // produced once the static filled it in.
    const all = await Shell.query<Shell>(new QueryRequest({ type: Shell.type, name: `${Shell.type} static query` }));
    return all.filter((s) => s.status !== ShellStatus.CLOSED).sort((a, b) => (a.tab_order ?? 0) - (b.tab_order ?? 0));
  }
}
