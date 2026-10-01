import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { isApiError } from '../ApiResponse';
import apiClient from '../client';
import { dataContext } from '../FlowSync/context';
import { QueryRequest } from '../FlowSync/query';
import { IEntity, EntityMerge } from '../IEntity';
import { ActionInfo } from '../models';
import { TargetedDock } from '../models/DockPointer';
import { TypeId } from '../models/TypeId';
import { PtyConnection, stripAnsi } from '../services/shell/ptyConnection';
import { ViewType } from '../utils/ui/view-types';
import type { CliResult } from '../models/ReturnedValue';

export const ShellStatus = {
  IDLE: 'idle',
  RUNNING: 'running',
  CLOSING: 'closing',
  CLOSED: 'closed',
  ERROR: 'error',
} as const;

export type ShellStatus = (typeof ShellStatus)[keyof typeof ShellStatus];

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
  /** What this terminal is the terminal OF (`snippet:<path>`, `deployment:<id>`) — see `Shell.belongingTo`. */
  belongs_to?: string | null;
}

/** How a command typed into a terminal ended (`Shell.runCommand`). */
export interface ShellRunResult {
  /** The command's exit code; 130 after a Ctrl-C. */
  exitCode: number;
  /** What it printed (its last `Shell.RUN_OUTPUT_CAP` characters), escapes stripped — without
   *  the terminal's echo of the command. */
  output: string;
  durationS: number;
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
  belongs_to: string | null = null;

  /** The start in flight, so concurrent callers of `ensureStarted` share one. */
  private _starting: Promise<void> | null = null;

  /** The marker of the run `runCommand` is waiting on — what makes `interrupt()` exact. */
  private _runMarker: string | null = null;

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

  /**
   * This terminal live and attached, started if it is not — ONE start however many callers
   * ask at once (a view mounting, a Run click). The way to get a live terminal; `start` is the
   * raw open it wraps.
   */
  async ensureStarted(opts: IShellStartOptions = {}): Promise<void> {
    if (this.ptyConnection.isLive) return;
    this._starting ??= this.start(opts)
      .then(() => undefined)
      .finally(() => {
        this._starting = null;
      });
    return this._starting;
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

  // ── Commands in the terminal ──────────────────────────────────────────────

  /**
   * Type `command` into this terminal and resolve when it ends: its exit code and what it
   * printed. The output shows in the terminal as it is printed; the backend wraps the command in
   * invisible start/end markers (`Shell.sentinel_command`), read off the live stream here — the
   * end arrives however the command ends, a Ctrl-C included (exit 130), and `output` is exactly
   * what lies between them, never the terminal's echo of the command. `signal` stops the WAIT,
   * never the command: stopping it is `interrupt()`.
   */
  async runCommand(command: string, opts: { signal?: AbortSignal; clear?: boolean } = {}): Promise<ShellRunResult> {
    const started = performance.now();
    const { signal } = opts;
    let raw = '';
    let scanned = 0;
    let marker: { start: string; end: RegExp } | null = null;
    let finish: (result: ShellRunResult) => void = () => undefined;
    const ended = new Promise<ShellRunResult>((resolve) => (finish = resolve));
    const aborted = new Promise<never>((_, reject) => {
      const fail = () => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      if (signal?.aborted) fail();
      signal?.addEventListener('abort', fail, { once: true });
    });
    aborted.catch(() => undefined); // an abort after the command ended has nobody to tell
    // Only new text can hold the end (plus a marker's length of what came before it).
    const look = () => {
      if (!marker) return;
      const from = Math.max(0, scanned - 64);
      const m = marker.end.exec(raw.slice(from));
      scanned = raw.length;
      if (m) {
        const at = raw.indexOf(marker.start);
        const printed = raw.slice(at < 0 ? 0 : at + marker.start.length, from + m.index);
        finish({ exitCode: Number(m[1]), output: stripAnsi(printed), durationS: (performance.now() - started) / 1000 });
      } else if (raw.length > Shell.RUN_OUTPUT_CAP * 2) {
        raw = raw.slice(-Shell.RUN_OUTPUT_CAP); // a run that prints for hours
        scanned = raw.length;
      }
    };
    // Listen before asking: a quick command's end can arrive before the answer that names it.
    const off = this.ptyConnection.onText((text) => {
      raw += text;
      look();
    });
    try {
      const answer = await this.post<{ marker: string; osc?: number } | null>('run-command', {
        command,
        ...(opts.clear ? { clear: true } : {}),
      });
      if (!answer?.marker) throw new Error(`Shell ${this.id} could not run the command`);
      this._runMarker = answer.marker;
      const prefix = `\x1b]${answer.osc ?? Shell.SENTINEL_OSC};${answer.marker};`;
      marker = { start: `${prefix}s\x07`, end: new RegExp(`${prefix.replace(/[\]\[]/g, '\\$&')}(-?\\d+)\x07`) };
      scanned = 0;
      look();
      return await Promise.race([ended, aborted]);
    } finally {
      off();
      this._runMarker = null;
    }
  }

  /** Stop the command running in this terminal (Ctrl-C, then what is left is killed); the
   *  terminal stays. Whether nothing of it is left running. A run `runCommand` is waiting on is
   *  named by its marker, so the stop reaches exactly its jobs and waits for its end. */
  async interrupt(): Promise<boolean> {
    const answer = await this.post<{ stopped: boolean } | null>('interrupt', this._runMarker ? { marker: this._runMarker } : {});
    return Boolean(answer?.stopped);
  }

  /** Whether a command runs in this terminal now — the backend's answer, not a guess from output. */
  async runState(): Promise<{ running_pid: number | null; status: string }> {
    const action = new ActionInfo('run-state', Shell.type, this.id, 'GET');
    return (await dataManager.callAction<undefined, { running_pid: number | null; status: string }>(action)) ?? {
      running_pid: null,
      status: this.status,
    };
  }

  /** Run `command` in a subprocess OUTSIDE the terminal (nothing shows in it). The answer is
   *  the command's `CliResult`: `returncode` is its own exit, `exit_code` the verdict. */
  async runDetached(command: string): Promise<CliResult> {
    return await this.post<CliResult>('run-detached', { command });
  }

  async setEnv(vars: Record<string, string>): Promise<void> {
    const result = await this.post<any>('set-env', { vars });
    // Apply the server's merged env locally (same convention as `open()`), so a
    // read of `this.env` right after the await is correct without racing the
    // `data_op_msg` WS delivery that would otherwise be the only writer.
    if (result?.env) this.env = result.env as Record<string, string>;
  }

  // ── Static helpers ────────────────────────────────────────────────────────

  /** The OSC number of the backend's run markers (`Shell.SENTINEL_OSC`) — `run-command` answers it too. */
  static SENTINEL_OSC = 7770;
  /** How much of a run's output `runCommand` keeps: the last megabyte (the terminal shows all). */
  static RUN_OUTPUT_CAP = 1 << 20;

  /**
   * The terminal of `what` — a natural name (`run:<project path>`) — the one it had, else a new
   * one, with a live PTY on the backend. Attach with `ensureStarted()`.
   */
  static async belongingTo(what: string, opts: { workdir?: string; name?: string } = {}): Promise<Shell> {
    const data = await apiClient.post<IShell>('/api/v1/shell/belonging-to', { what, ...opts });
    return Shell.adopt(data);
  }

  /** The snippet file's own terminal (made now if it has none) and the command that runs the file there. */
  static async forSnippet(path: string): Promise<{ shell: Shell; command: string }> {
    const found = await Shell.snippetTerminal(path, true);
    if (!found) throw new Error(`the terminal of ${path} could not be opened`);
    return found;
  }

  /** The snippet file's terminal if it already has one — found, never made (no PTY is started). */
  static async findForSnippet(path: string): Promise<{ shell: Shell; command: string } | null> {
    return Shell.snippetTerminal(path, false);
  }

  private static async snippetTerminal(path: string, create: boolean): Promise<{ shell: Shell; command: string } | null> {
    const data = await apiClient.post<{ shell_id: string | null; command: string }>('/api/v1/snippet/terminal', { path, create });
    const shell = data.shell_id ? ((await Shell.getById(data.shell_id)) as Shell | null) : null;
    return shell ? { shell, command: data.command } : null;
  }

  /** The cached instance for these fields, refreshed — never a second instance of one shell
   *  (a second one orphans the first's output subscribers). */
  private static adopt(data: Partial<IShell>): Shell {
    const existing = data.id ? Shell.getByIdFromCache(data.id) : null;
    if (existing) {
      Object.assign(existing, data);
      return existing as Shell;
    }
    return new Shell(data);
  }

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
        // The cached instance, refreshed — a second `new Shell(d)` would orphan the first's
        // subscribers (InteractiveTerminal's onOutput would keep firing on it while PTY routing
        // hits the new one).
        results.push(Shell.adopt(d));
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
