/**
 * AgenticProcess Entity - Represents a running instruction execution
 *
 * Extends APIEntity to receive entity notifications from the backend.
 * Provides:
 * - state: Current processor state
 * - output(): AsyncGenerator for streaming FlowData
 * - stackFrame: Access to execution variables
 */

import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { isApiError } from '../ApiResponse';
import { IEntity } from '../IEntity';
import { FSRef, type FSRefJson } from '../fs/FSRef';
import { ClaudeCliOptions } from '../cli_workers';
import { dataContext } from '../FlowSync/context';
import { FlowDataFactory } from '../entities/flow/flow-data-factory';
import { Shell, ShellStatus } from '../entities/shell';
import { FlowData, FlowDataSource } from '../flow_processing';
import { FlowElementTypes } from '../flow_processing/flow-element-types';
import { ActionInfo } from '../models/ActionInfo';
import type { AssetDescriptor } from './asset-descriptor';
import { DockPointerData } from '../models/DockPointer';
import { TypeId } from '../models/TypeId';
import { InstructionFile } from '../models/workflow/InstructionFile';
import { ViewType } from '../utils/ui/view-types';
import { VFSPath } from '../utils/vfs-path';
import { AgenticContext, IAgenticProcessOptions, ISpawnWorkerOptions, PermissionMode } from './agentic-context';
import type { ProcessType } from './process-types';
import { ProcessIconKey, ProcessStatus, WorkerStatus, isWorkerRunning, isWorkerTerminal } from './agentic-types';
import type {
  TranscriptFormat as TranscriptFormatType,
  TranscriptSource as TranscriptSourceType,
} from '../transcript-analyzer';

// ---------------------------------------------------------------------------
// Auto-recovery dispatcher — mirrors Shell's static-listener pattern at
// ts_sdk/src/entities/shell.ts:81-95. A single ConnectionManager listener and
// a periodic poll drive a *single batched* os-status round-trip for every
// registered AgenticProcess; results are fanned back out to each instance's
// ``reconnectFromOsStatus(...)`` to make the per-process recovery decision.
//
// This is the consolidated form of what used to be one ``GET /os-status``
// per registered process per tick — see ``compute_node/os-status-batch``.
// ---------------------------------------------------------------------------
const _agenticProcessRegistry = new Set<AgenticProcess>();
let _agenticListenersRegistered = false;
let _pollTimer: ReturnType<typeof setInterval> | null = null;
const _POLL_INTERVAL_MS = 5000;

interface OsStatusBatchResponse {
  statuses: Record<string, AgenticProcessOSStatus>;
  missing: string[];
}

/** One sweep: batch-fetch os-status for every registered AP and dispatch
 *  recovery decisions. Falls back to per-AP probes only when there is no
 *  compute_node context yet (early bootstrap), which is the same shape as
 *  the legacy fan-out so behavior degrades gracefully. */
async function _dispatchRecoverySweep(): Promise<void> {
  if (_agenticProcessRegistry.size === 0) return;
  const procs = Array.from(_agenticProcessRegistry);
  const computeNodeId = dataContext.computeNode?.id;
  if (!computeNodeId) {
    for (const p of procs) void p.reconnect();
    return;
  }
  const action = new ActionInfo('os-status-batch', 'compute_node', computeNodeId, 'POST');
  action.bodyParameters = { process_ids: procs.map((p) => p.id) };
  let result: OsStatusBatchResponse | null = null;
  try {
    result = await dataManager.callAction<{ process_ids: string[] }, OsStatusBatchResponse>(action);
  } catch {
    // Batch failed (compute_node unreachable, transient HTTP error). Skip
    // this tick — the next one will retry. Per-AP ``getOsStatus()`` remains
    // available for on-demand callers.
    return;
  }
  const statuses = result?.statuses ?? {};
  for (const p of procs) {
    const s = statuses[p.id];
    if (s) void p.reconnectFromOsStatus(s);
  }
}

function _ensureAgenticStaticListeners(): void {
  if (_agenticListenersRegistered) return;
  _agenticListenersRegistered = true;
  void import('../websocket').then(({ ConnectionManager }) => {
    const cm = ConnectionManager.getInstance();
    cm.on('on_reconnected', () => { void _dispatchRecoverySweep(); });
  });
  if (_pollTimer === null) {
    _pollTimer = setInterval(() => { void _dispatchRecoverySweep(); }, _POLL_INTERVAL_MS);
  }
}

/**
 * Predicate consumed by ``Shell._onCmReconnected`` so the bare-shell
 * reconnect handler skips shells that are owned by an AgenticProcess. The
 * process layer drives recovery — it knows the session_id, --resume, env
 * injection. Bare ``Shell.start()`` would just spawn an empty PTY.
 */
export function _isShellOwnedByAgenticProcess(shellId: string): boolean {
  for (const proc of _agenticProcessRegistry) {
    if (proc.shell_id === shellId) return true;
  }
  return false;
}

/**
 * Result returned by AgenticProcess.spawn().
 */
export interface SpawnResult {
  process: AgenticProcess;
  /** Set in PTY mode */
  shell?: Shell;
  /** Set in both modes */
  workerSessionId?: string | null;
}

/**
 * Options for AgenticProcess.execute()
 * Note: compute node is managed by the backend process runtime, not passed from frontend.
 */
export interface ExecuteOptions {
  /** Working directory for file operations */
  workdir?: string;
  /** LLM model to use */
  model?: string;
  /** Permission mode for sensitive operations */
  permissionMode?: PermissionMode;
}

/**
 * ProcessState — minimal status wrapper for a process instance.
 */
export interface ProcessState {
  status: WorkerStatus;
}

/**
 * OS-level status snapshot returned by the backend ``os-status`` action.
 * Single source of truth for "is this process alive right now?". Combines
 * persisted entity status, in-memory PTY-session state on the compute
 * node, and a real PID liveness check (psutil + cmdline match).
 *
 * ``ready`` is the answer to ``AgenticProcess.isAlive()``: true iff the
 * PTY session is alive AND the worker PID matches the recorded session.
 */
export interface AgenticProcessOSStatus {
  process_id: string;
  process_status: string;
  shell_id: string | null;
  shell_status: string | null;
  session_id: string | null;
  pty_pid: number | null;
  worker_pid: number | null;
  worker_name: string | null;
  pty_alive: boolean;
  worker_alive: boolean;
  has_attachable_pty: boolean;
  ready: boolean;
  reason: string | null;
  checked_at: string;
}

/**
 * Response from get-history action
 */
interface HistoryResponse {
  history: Array<{
    flow_value: unknown;
    attributes: Record<string, string>;
    index?: number;
    part?: number;
    created_time?: string;
    focus?: string;
  }>;
  count: number;
  session_id: string | null;
  use_worker_history: boolean;
}

export enum AgenticProcessEventName {
  FirstPrompt = 'first_prompt',
}

export interface AgenticProcessReportEventResult {
  accepted: boolean;
  scheduled: boolean;
  process_id: string;
  worker_type?: string | null;
  session_id: string | null;
  event_name: AgenticProcessEventName;
  event_data: Record<string, unknown>;
  request_id?: string | null;
  task_name?: string;
}

/**
 * Interface for AgenticProcess entity data
 */
export interface IAgenticProcess extends IEntity {
  instruction_content?: string;
  asset_ref?: string;
  workdir?: string | null;
  context_data?: Record<string, unknown>;
  // ``shared_context_entities`` is inherited from IEntity (wire shape).
  // ``privateContextEntities`` is exposed by the APIEntity getter — no
  // field is declared here for it (local-only, never on the wire).
  favorite_index?: number | null;
  readonly status?: ProcessStatus;
  readonly worker_status?: WorkerStatus;
  session_id?: string | null;
  /**
   * USD cost of this process's session transcript so far. Computed
   * server-side from the session jsonl via
   * flow_sdk.transcript_analyzer.pricing.total_cost_usd; not persisted on
   * the entity. Null when no session_id exists yet.
   */
  total_cost_usd?: number | null;
  use_worker_history?: boolean;
  /** False=direct PTY spawn (default), True=legacy zsh intermediary */
  shell_mode?: boolean;
  /** CLI worker vendor (e.g. 'claude', 'codex'). Drives icon selection. */
  worker_type?: string | null;
  /** Discriminates how this process is being used (chat vs execution). */
  process_type?: ProcessType | null;
  /** Shell entity ID linked to this process */
  shell_id?: string | null;
  /** Whether this process is visible in the tabs view */
  visible?: boolean;
  /** Sidecar plain shell PTY session ID */
  sidecar_shell_id?: string | null;
  /** True when PTY OSC title escapes may update `name`. Cleared the first time the user manually renames this tab. */
  auto_rename?: boolean;
  /**
   * Derived: true when the worker is ready for a new user prompt.
   * Computed server-side via ``is_ready_for_input``. Read-only on the wire.
   */
  ready_for_input?: boolean;
  /**
   * Epoch-ms timestamp approximating when the worker became ready-for-input
   * (transcript-file mtime). Stable across refresh so the UI pending-action
   * store can compare against a persisted ack and avoid re-arming the glow
   * for a transition the user has already seen. Null when not ready or when
   * the transcript is unavailable.
   */
  ready_for_input_since?: number | null;
  /** @internal — use AgenticProcess.cliOptions getter/setter instead */
  cli_config?: Record<string, any>;
  /** Extra directories passed to Claude via --add-dir */
  additional_dirs?: string[];
  /** TypeIds of entities materialized under the process's assets dir. */
  embedded_asset_refs?: TypeId[];
  /** Owning project ID */
  project_id?: string | null;
  /** CollaborationRoom this process was spawned in, if any */
  collaboration_room_id?: string | null;
  /** VFS path the process is keyed to. Either an entity TypeId ("type-id") for entity-scoped processes, or "<typeid>/<sub_path>" for surface-scoped processes (e.g. a per-doc process keyed on the file path). */
  target_typeid_str?: string | null;
  /**
   * True when a worker-relevant field changed since the last successful start()
   * while status==RUNNING. Backend sets this automatically via the save-hook;
   * external callers may write it directly to signal an out-of-band change.
   * Cleared only by start() on its success path.
   */
  restart_required?: boolean;
  /**
   * MD5 of the worker-relevant snapshot captured at the last successful start().
   * Compared against the current snapshot on every save() to detect drift.
   */
  last_started_hash?: string | null;
  /** Root of the per-process execution folder — `<record_dir>/execution/`. */
  exe_folder?: FSRefJson | null;
  /** `<exe_folder>/input/` — instruction/queue inputs. */
  input_folder?: FSRefJson | null;
  /** `<exe_folder>/output/` — artifacts the agent writes back. */
  output_folder?: FSRefJson | null;
  /** `<exe_folder>/assets/` — materialised embedded agents / skills. */
  assets_folder?: FSRefJson | null;
  /**
   * Absolute path to the latest plan markdown produced by this process,
   * or null if the process has not produced a plan yet.
   *
   * Populated either by the line-trigger pipeline (when the path appears
   * in PTY output) or by the server-side ``get-plan`` action when it
   * resolves the path from the transcript JSONL. Persists across reloads
   * so the "Open Plan" UI affordance survives a refresh without needing
   * the trigger to re-fire.
   */
  plan_path?: string | null;
}

/**
 * AgenticProcess Entity - A running instruction execution process
 *
 * Created by AgenticProcess.spawn(), this entity tracks execution state
 * and provides streaming access to FlowData outputs.
 *
 * @example
 * ```typescript
 * const process = await AgenticProcess.spawn({ workdir }, { instruction: 'Run the task' });
 *
 * // Stream outputs as they arrive
 * for await (const flowData of process.output()) {
 *   console.log('Received:', flowData);
 * }
 *
 * // Access final state
 * console.log('Final variables:', process.state.variables);
 * console.log('Stack frame:', process.stackFrame);
 * ```
 */
@registerEntity
export class AgenticProcess extends APIEntity<AgenticProcess> implements IAgenticProcess {
  /** Entity type for AgenticProcess */
  static type: string = 'agentic_process';

  // ============ Static Execute API ============

  /**
   * Execute a command and return the process for streaming.
   *
   * This is the simplest entry point for running instructions, similar to
   * a Python interpreter's exec(). Creates all required components internally.
   *
   * @param command - Plain text command or AMD content to execute
   * @param options - Optional execution options
   * @returns AgenticProcess for streaming output via output() method
   *
   * @example
   * ```typescript
   * // Simple one-shot execution
   * const process = await AgenticProcess.execute("List all Python files");
   * for await (const data of process.output()) {
   *   console.log(data.data);
   * }
   *
   * // With options
   * const process = await AgenticProcess.execute("Say hello", {
   *   workdir: '/path/to/project',
   *   model: 'claude-sonnet-4-20250514',
   * });
   * ```
   */
  static async execute(command: string, options?: ExecuteOptions): Promise<AgenticProcess> {
    const { dataContext } = await import('../FlowSync/context');
    const computeNode = dataContext.computeNode;
    if (!computeNode) throw new Error('[AgenticProcess.execute] No local compute node');

    const context: AgenticContext = {
      workdir: options?.workdir,
      model: options?.model,
      permissionMode: options?.permissionMode ?? 'bypassPermissions',
    };

    const amdContent = AgenticProcess._wrapInAmd(command);
    const process = await computeNode.createProcess(context);
    await process.watch();
    await process.executeInstruction(amdContent, { sync: false });
    return process;
  }

  /**
   * Spawn a visible AgenticProcess tab and (optionally) send an initial
   * prompt. Mirrors the `Start Claude` / `Start Codex` openers in
   * TabbedTerminal — use this from any UI surface outside the tab strip
   * (e.g. an editor "discuss this doc" button) that needs to launch a
   * harness tab pre-filled with a user prompt.
   *
   * @param workerType - `'claude_code'` or `'codex'`
   * @param prompt - Optional initial user prompt. Delivered via the backend
   *   `execute` action, which routes to `prompt()` → `send()` and writes the
   *   text into the running PTY's stdin so the worker picks it up as its
   *   first user message.
   * @returns The spawned AgenticProcess (already navigated to).
   */
  static async openTab(
    workerType: 'claude_code' | 'codex',
    prompt?: string,
  ): Promise<AgenticProcess> {
    const computeNode = dataContext.computeNode;
    if (!computeNode) throw new Error('[AgenticProcess.openTab] No local compute node');
    const project = dataContext.project;
    const process = await computeNode.createProcess(
      {
        workdir: project?.fs_storage_mount_path ?? undefined,
        ...(project?.id ? { projectId: project.id } : {}),
        workerType,
      },
      { visible: true, watchProcess: false },
    );
    process.openTerminalDock();
    if (prompt) {
      // Call backend `execute` action directly: bypasses the TS-side
      // `isWorkerRunning` guard in executeInstruction() (the just-spawned PTY
      // *is* running, which is exactly when we want to send to its stdin).
      const actionInfo = new ActionInfo('execute', AgenticProcess.type, process.id, 'POST');
      actionInfo.bodyParameters = { instruction: prompt };
      try {
        await dataManager.callAction(actionInfo);
      } catch (err) {
        console.error('[AgenticProcess.openTab] execute failed', err);
      }
    }
    return process;
  }

  /**
   * Create and activate an AgenticProcess in one call.
   *
   * Replaces the manual `createProcess -> start/watch` pattern.
   * Use `headless: true` in workerOptions for background execution (no PTY).
   *
   * @example PTY shell
   * ```typescript
   * const { process, shellId } = await AgenticProcess.spawn(
   *   { permissionMode: 'bypassPermissions', workdir },
   *   { instruction: 'Do the thing' },
   * );
   * ```
   *
   * @example Headless
   * ```typescript
   * const { process } = await AgenticProcess.spawn(
   *   { permissionMode: 'bypassPermissions', resumeSessionId: id, forkSession: true },
   *   { headless: true },
   * );
   * await process.executeInstruction('...', { sync: false });
   * ```
   */
  static async spawn(options: IAgenticProcessOptions, workerOptions?: ISpawnWorkerOptions): Promise<SpawnResult> {
    const cliConfig = new ClaudeCliOptions({
      model: options.model,
      permission_mode: options.permissionMode ?? 'bypassPermissions',
      chrome: options.chrome,
      debug: options.debug,
      worktree: options.worktree,
      agents_json: options.agentsJson,
      env_vars: options.envVars,
      ...(options.resumeSessionId
        ? options.forkSession
          ? { resume: true, fork_session_id: options.resumeSessionId }
          : { resume: true, session_id: options.resumeSessionId }
        : {}),
    });

    const process = await new AgenticProcess({
      cli_config: cliConfig.toJson(),
      // When resuming, seed session_id on the entity so Python's start() keeps it
      // instead of generating a new UUID (which would break transcript lookup).
      ...(options.resumeSessionId && !options.forkSession ? { session_id: options.resumeSessionId } : {}),
      context_data: {
        instructions: options.instructions,
        project_id: options.projectId,
        max_thinking_tokens: options.maxThinkingTokens ?? 1024,
        ...(options.resumeSessionId && !options.forkSession ? { resume_session_id: options.resumeSessionId } : {}),
      },
      workdir: options.workdir,
      visible: workerOptions?.visible,
      shell_mode: options.shellMode,
      ...(options.targetVfsPath ? { target_typeid_str: options.targetVfsPath } : {}),
    }).save(options.scope ?? []);

    if (workerOptions?.headless) {
      await process.watch();
      if (workerOptions.instruction) {
        await process.executeInstruction(workerOptions.instruction, {
          sync: workerOptions.sync ?? false,
          workerSessionId: workerOptions.workerSessionId,
        });
      }
      return { process, workerSessionId: workerOptions.workerSessionId };
    }

    await process.start({
      instruction: workerOptions?.instruction,
      ptyTimeout: workerOptions?.ptyTimeout,
    });
    return { process, shell: await process.shell(), workerSessionId: process.session_id };
  }

  /**
   * Get a process by ID with history auto-loaded.
   *
   * Unlike the base getById, this method automatically loads the process
   * history from the backend, making the process ready for inspection
   * or continuation.
   *
   * @param id - Process ID
   * @returns AgenticProcess with history loaded, or null if not found
   *
   * @example
   * ```typescript
   * const process = await AgenticProcess.getById(processId);
   * if (process) {
   *   console.log('History items:', process.flowDataStream.items.length);
   *   // Can continue execution
   *   await process.execute("Next instruction");
   * }
   * ```
   */
  static async getByIdWithHistory(id: string): Promise<AgenticProcess | null> {
    const typeId = new TypeId(AgenticProcess.type, id);
    const process = await dataManager.getByTypeId<AgenticProcess>(typeId);
    if (process) {
      await process.loadHistory();
    }
    return process;
  }

  /**
   * Open (or create) an AgenticProcess for a Record and ensure it has a live PTY.
   *
   * If an entity already exists for the given record ID it is reused;
   * otherwise a new AgenticProcess is created from the record's session_id.
   * start() is called to spawn or reuse a PTY (idempotent).
   *
   * @param record - Object with `id` and optional `session_id`
   * @returns AgenticProcess with an active shell session
   */
  static async openRecordInTerminal(record: { id: string; session_id?: string | null }): Promise<AgenticProcess> {
    let entity = await AgenticProcess.getById(record.id).catch(() => null);

    if (!entity && record.session_id) {
      entity = new AgenticProcess({ session_id: record.session_id });
      await entity.save();
    }

    if (!entity) {
      throw new Error('Cannot open terminal: no session_id on Record');
    }

    // start() is idempotent: no-op if PTY alive, restarts with claude --resume if stale.
    await entity.start();

    return entity;
  }

  /**
   * Resolve a worker/session/thread id to a ready-to-use AgenticProcess.
   *
   * Single round-trip: backend auto-discovers worker_type (Claude or Codex),
   * resolves cwd + project from the on-disk session record, upserts the
   * AgenticProcess (heals existing or creates+starts a new one), and returns
   * the full entity dict. We hydrate the dataManager cache directly — no
   * follow-up `getById` needed.
   *
   * @param workerId - Claude session id, Codex thread id, or any future worker id.
   * @returns The AgenticProcess entity, or `null` if no on-disk session matches.
   */
  static async getByWorkerId(workerId: string): Promise<AgenticProcess | null> {
    const computeNode = dataContext.computeNode;
    if (!computeNode) throw new Error('[AgenticProcess.getByWorkerId] No compute node');

    const action = new ActionInfo('terminals', 'compute_node', computeNode.id, 'GET');
    action.subpath = `get_by_worker_id/${workerId}`;
    try {
      const data = await dataManager.callAction<void, IAgenticProcess | null>(action);
      if (!data) return null;
      return dataManager.castAndDeepAssign<AgenticProcess>(data) as AgenticProcess;
    } catch (e) {
      if (isApiError(e) && e.response?.status === 404) return null;
      throw e;
    }
  }

  /**
   * Check if content is already in AMD format.
   * @internal
   */
  private static _isAmdContent(content: string): boolean {
    return /<!--\s*<\/?flow-[a-z]+/i.test(content);
  }

  /**
   * Wrap plain text in AMD flow-do syntax.
   * @internal
   */
  private static _wrapInAmd(command: string): string {
    if (AgenticProcess._isAmdContent(command)) {
      return command;
    }
    const instrId = `instr_${Date.now().toString(36)}`;
    return `<!-- <flow-do id="${instrId}"> -->\n${command}\n<!-- </flow-do> -->`;
  }

  /**
   * Live interactive terminal — `/dock/shell/agentic_process-<id>`.
   * Use this when the user wants to attach to (or launch) the running PTY.
   */
  get terminalDockPointer(): DockPointerData {
    return new DockPointerData(ViewType.SHELL, `${AgenticProcess.type}${TypeId.DELIMITER}${this.id}`);
  }

  openTerminalDock(extraOptions?: Record<string, string>): void {
    const nav = (window as any).navigation as
      | { openDock: (pointer: DockPointerData, extraOptions?: Record<string, string>) => void }
      | undefined;
    nav?.openDock(this.terminalDockPointer, extraOptions);
  }

  /**
   * Read-only transcript — `/dock/lens/<worker_type>/transcript/<session_id>`.
   *
   * Single-segment ref form. The server-side resolver
   * (``flow_sdk.transcript_analyzer.resolver``) globs the actual on-disk JSONL
   * from worker_type + session_id, so callers don't need to know any path
   * encoding. Falls back to the terminal pointer when no session is attached
   * yet (fresh process before first message).
   */
  get transcriptDockPointer(): DockPointerData {
    if (!this.session_id) return this.terminalDockPointer;
    const wt = (this.worker_type ?? 'claude').toLowerCase();
    const worker = wt === 'codex' ? 'codex' : 'claude';
    return new DockPointerData(ViewType.LENS, `${worker}/transcript/${this.session_id}`);
  }

  /**
   * Default dock pointer — the read-only transcript. Surfaces that historically
   * meant "attach to terminal" should reference {@link terminalDockPointer}
   * explicitly. The default is transcript because reading prior runs is the
   * dominant gesture once a process has terminated.
   */
  get dockPointer(): DockPointerData {
    return this.transcriptDockPointer;
  }

  /**
   * True when this process was created by resuming or forking a prior CLI
   * session (not a fresh start). Derived from the persisted ``cli_config``
   * so the answer is stable across reloads.
   *
   * The signal: ``cli_config.resume === true`` (passed when the user opened
   * an existing ``session_id``) or ``cli_config.fork_session_id`` (passed
   * when forking off a prior session). A bare ``session_id`` on the entity
   * by itself isn't enough — that field is also populated for fresh
   * processes once the CLI assigns one.
   */
  get wasRestoredFromSession(): boolean {
    const cfg = this.cli_config as { resume?: boolean; fork_session_id?: string | null } | undefined;
    if (!cfg) return false;
    return Boolean(cfg.resume === true || cfg.fork_session_id);
  }

  /**
   * Symbolic icon key for this process — the UI resolves it to a concrete
   * React component via the ``pickProcessIcon`` registry. Two axes drive
   * the choice:
   *
   * - **vendor**: ``worker_type`` ('claude' / 'codex' / fallback)
   * - **state**: fresh-start vs ``wasRestoredFromSession``
   */
  get icon(): ProcessIconKey {
    const wt = (this.worker_type ?? '').toLowerCase();
    const restored = this.wasRestoredFromSession;
    if (wt === 'codex') return restored ? 'codex-restore' : 'codex';
    // Default to claude — that's what AgenticProcess.spawn produces today
    // (ClaudeCliOptions hardcoded), so an unset worker_type means claude.
    if (wt === '' || wt === 'claude' || wt.startsWith('claude_') || wt.startsWith('claude-')) {
      return restored ? 'claude-restore' : 'claude';
    }
    return restored ? 'generic-restore' : 'generic';
  }

  /** @deprecated alias of {@link transcriptDockPointer} */
  get searchDockPointer(): DockPointerData {
    return this.transcriptDockPointer;
  }

  /** Instruction content being executed */
  instruction_content?: string;

  /** Source VFS path of the executed file */
  asset_ref?: string;

  /** Persisted context data for session restoration */
  context_data?: Record<string, unknown>;

  // TypeIds of entities this process is contextually about (task /
  // conversation / spec / project / …) now live on the base APIEntity as
  // ``sharedContextEntities`` (wire-bound) and ``privateContextEntities``
  // (local). The constructor populates them from the wire field
  // ``shared_context_entities``.

  /** Optional pinning index for tab ordering */
  favorite_index?: number | null;

  /** True when PTY OSC title escapes may update `name`. Cleared the first time the user manually renames this tab. */
  auto_rename: boolean = true;

  /** Backend-owned lifecycle status. */
  private _status: ProcessStatus = ProcessStatus.NEW;

  /** Granular transcript-derived worker status. */
  private _workerStatus: WorkerStatus = WorkerStatus.INITIALIZING;

  /** Backend-owned lifecycle status. Read-only outside this class. */
  get status(): ProcessStatus {
    return this._status;
  }

  private set status(value: ProcessStatus) {
    this._status = value;
  }

  /** Transcript-derived worker status. Read-only outside this class. */
  get workerStatus(): WorkerStatus {
    return this._workerStatus;
  }

  private set workerStatus(value: WorkerStatus) {
    this._workerStatus = value;
  }

  /** Worker session ID for resume capability */
  session_id?: string | null;

  /** Whether worker manages its own history */
  use_worker_history?: boolean;

  /** False=direct PTY spawn (default), True=legacy zsh intermediary */
  shell_mode?: boolean;

  /** CLI worker vendor (e.g. 'claude', 'codex'). Drives icon selection. */
  worker_type?: string | null;

  /** Discriminates how this process is being used (chat vs execution). */
  process_type?: ProcessType | null;

  /** Shell entity ID linked to this process */
  shell_id?: string | null;

  /** Whether this process is visible in the tabs view */
  visible?: boolean;

  /** Sidecar plain shell PTY session ID */
  sidecar_shell_id?: string | null;

  /** Owning project ID */
  project_id?: string | null;

  /** CollaborationRoom this process was spawned in, if any */
  collaboration_room_id: string | null = null;

  /** VFS path the process is keyed to. Either an entity TypeId ("type-id") for entity-scoped processes, or "<typeid>/<sub_path>" for surface-scoped processes (e.g. a per-doc process keyed on the file path). */
  target_typeid_str: string | null = null;

  /**
   * True when a worker-relevant field changed since the last successful start()
   * while status==RUNNING. Maintained by the backend save-hook; UI surfaces
   * this as the "Restart" affordance on the process toolbar.
   */
  restart_required: boolean = false;

  /**
   * MD5 of the worker-relevant snapshot captured at the last successful start().
   * Compared against the current snapshot on every save() to detect drift.
   */
  last_started_hash: string | null = null;

  /** Execution folder — `<record_dir>/execution/`. Null until the process has a record on disk. */
  exe_folder: FSRef | null = null;

  /** `<exe_folder>/input/`. */
  input_folder: FSRef | null = null;

  /** `<exe_folder>/output/` — where the agent writes artifacts back. */
  output_folder: FSRef | null = null;

  /** `<exe_folder>/assets/` — materialised embedded agents / skills. */
  assets_folder: FSRef | null = null;

  /** Deserialize cli_config into a live ClaudeCliOptions instance.
   *
   * Mirrors Python AgenticProcess.cli_options property exactly:
   * workdir and session_id are injected from entity fields (not stored in cli_config).
   */
  get cliOptions(): ClaudeCliOptions {
    const cmd = ClaudeCliOptions.fromJson(this.cli_config ?? {});
    if (this.session_id) cmd.session_id = this.session_id;
    const wd = this.workdir;
    if (wd) {
      cmd.workdir = wd;
      cmd.envVars['CLAUDE_PROJECT_DIR'] ??= wd;
    }
    cmd.addDirs = this.additional_dirs ?? [];
    return cmd;
  }

  set cliOptions(cmd: ClaudeCliOptions) {
    this.cli_config = cmd.toJson();
  }

  /** Append a directory to additional_dirs (passed to Claude via --add-dir). */
  async addDir(path: string): Promise<void> {
    const actionInfo = new ActionInfo('add-dir', AgenticProcess.type, this.id, 'POST');
    actionInfo.bodyParameters = { path };
    await dataManager.callAction(actionInfo);
    if (!(this.additional_dirs ?? []).includes(path)) {
      this.additional_dirs = [...(this.additional_dirs ?? []), path];
    }
  }

  /** Remove a directory from additional_dirs. No-op if not present. */
  async removeDir(path: string): Promise<void> {
    const actionInfo = new ActionInfo('remove-dir', AgenticProcess.type, this.id, 'POST');
    actionInfo.bodyParameters = { path };
    await dataManager.callAction(actionInfo);
    this.additional_dirs = (this.additional_dirs ?? []).filter((d) => d !== path);
  }

  async shell(): Promise<Shell | null> {
    if (!this.shell_id) return null;
    const w = (typeof window !== 'undefined' ? window : undefined) as
      | { __shellNavT0?: number }
      | undefined;
    const t0 = w?.__shellNavT0;
    const stamp = (label: string, start: number) => {
      if (t0 === undefined) return;
      const now = performance.now();
      // eslint-disable-next-line no-console
      console.log(`[PERF] +${(now - t0).toFixed(0)}ms ${label} took ${(now - start).toFixed(1)}ms`);
    };
    const sImport = performance.now();
    const { Shell } = await import('../entities/shell');
    stamp('process.shell: dynamic import("../entities/shell")', sImport);
    const sGet = performance.now();
    const result = await Shell.getById<Shell>(this.shell_id);
    stamp('process.shell: Shell.getById', sGet);
    return result;
  }

  /** The PTY connection for this process — delegates to the linked Shell. */
  get ptyConnection(): import('../services/shell/ptyConnection').PtyConnection | undefined {
    if (!this.shell_id) return undefined;
    const entity = dataManager.getByTypeIdFromCache(new TypeId('shell', this.shell_id)) as any;
    return entity?.ptyConnection;
  }

  async printPty(): Promise<void> {
    const sh = await this.shell();
    sh?.printPty();
  }

  // ── Line / trigger event surface ──────────────────────────────────────────

  /** Track the bridges we've registered against the shell so we don't double-bridge. */
  private _shellLineBridgeUnsub?: () => void;
  private _activePlanTriggerUnsub?: () => void;

  /**
   * Bridge line events from the attached Shell into this process so callers
   * can use ``process.on('line', fn)`` interchangeably with ``shell.onLine(fn)``.
   * Idempotent — re-bridging cleans up the previous link.
   */
  private async _ensureShellLineBridge(): Promise<void> {
    const sh = await this.shell();
    if (!sh) return;
    this._shellLineBridgeUnsub?.();
    this._shellLineBridgeUnsub = sh.onLine((line) => {
      this.emit('line', line);
    });
  }

  /**
   * Subscribe to ANSI-stripped output lines. Wires up the shell bridge on
   * first use so ``process.on('line', ...)`` works even before the shell is
   * fully attached. Returns an unsubscribe function.
   */
  onLine(handler: (line: string) => void): () => void {
    void this._ensureShellLineBridge();
    return this.on('line', handler);
  }

  /**
   * Subscribe to plan-detection events.
   *
   * Refresh-driven via ``process.on('status', ...)`` plus a one-time check
   * at registration. Runs ``getPlan()`` server-side whenever the process
   * is in the ``RUNNING`` state — server scans the JSONL transcript for
   * ``ExitPlanMode.planFilePath`` and persists ``plan_path`` on the entity.
   *
   * - With ``validate: false`` (default), ``handler`` is called with the
   *   resolved ``plan_path`` string (or ``null``).
   * - With ``validate: true``, ``handler`` receives the resolved
   *   ``Markdown`` entity (or ``null`` if no plan exists yet).
   *
   * NOTE: ``process.status`` does not transition mid-session, so during a
   * live Claude session the handler only fires on initial registration
   * (and on any later status transitions, e.g. process restart). To pick
   * up plans created during a session, the consumer must re-mount /
   * re-subscribe (page refresh handles this naturally).
   *
   * Returns an unsubscribe function.
   */
  onPlan<T = string | null>(
    options: { validate?: boolean },
    handler: (payload: T) => void,
  ): () => void {
    const validate = options.validate ?? false;

    const check = async (): Promise<void> => {
      if (this.status !== ProcessStatus.RUNNING) return;
      const md = await this.getPlan();
      if (validate) {
        handler(md as unknown as T);
      } else {
        handler((this.plan_path ?? null) as unknown as T);
      }
    };

    const unsubStatus = this.on('status', () => { void check(); });
    void check();

    return () => unsubStatus();
  }

  /**
   * Fetch the plan as a Markdown entity.
   *
   * Calls the ``transcript/plan`` sub-action — the server resolves the
   * plan file path (existence-gated), persists ``plan_path``, indexes the
   * file as a Markdown record, and returns it. Returns ``null`` if no
   * plan has been produced yet.
   */
  async getPlan(): Promise<import('../entities/markdown.js').Markdown | null> {
    const actionInfo = new ActionInfo('transcript', AgenticProcess.type, this.id, 'POST');
    actionInfo.subpath = 'plan';
    const response = await dataManager.callAction<
      unknown,
      { markdown?: Record<string, unknown> | null; plan_path?: string | null }
    >(actionInfo);
    if (response?.plan_path !== undefined) this.plan_path = response.plan_path ?? null;
    if (!response?.markdown) return null;
    return dataManager.updateEntityFromJson<import('../entities/markdown').Markdown>(
      response.markdown as Record<string, unknown>,
    );
  }

  /**
   * Fetch the canonical user-prompt list from the JSONL transcript.
   *
   * Calls ``transcript/prompts`` — the server walks the parsed transcript
   * and returns ``UserMessageEntry``-shaped dicts. Filters: drop sub-agent
   * (``is_sidechain``) lines, drop empty/whitespace text, drop the
   * ``[Request interrupted by user for tool use]`` synthetic. Hydrates
   * each entry via the analyzer's ``fromJson`` factory.
   */
  async getPrompts(): Promise<import('../transcript-analyzer').UserMessageEntry[]> {
    const { fromJson, UserMessageEntry } = await import('../transcript-analyzer');
    const actionInfo = new ActionInfo('transcript', AgenticProcess.type, this.id, 'POST');
    actionInfo.subpath = 'prompts';
    const response = await dataManager.callAction<
      unknown,
      { prompts?: Record<string, unknown>[] | null }
    >(actionInfo);
    const raw = response?.prompts ?? [];
    const out: import('../transcript-analyzer').UserMessageEntry[] = [];
    for (const r of raw) {
      const entry = fromJson(r);
      if (entry instanceof UserMessageEntry) out.push(entry);
    }
    return out;
  }

  /**
   * Fetch the parsed worker transcript from the process-specific transcript source.
   */
  async getTranscript(): Promise<import('../transcript-analyzer').AgentTranscript> {
    const {
      AgentTranscript,
      TranscriptFormat,
      TranscriptSource,
      fromJson,
    } = await import('../transcript-analyzer');
    const actionInfo = new ActionInfo('transcript', AgenticProcess.type, this.id, 'POST');
    actionInfo.subpath = 'full';
    const response = await dataManager.callAction<
      unknown,
      {
        worker_type?: string | null;
        session_id?: string | null;
        path?: string | null;
        transcript_path?: string | null;
        transcript_format?: string | null;
        transcript_source?: string | null;
        entries?: Record<string, unknown>[] | null;
      }
    >(actionInfo);
    const rawEntries = response?.entries ?? [];
    const entries = rawEntries.map((entry) => fromJson(entry));
    const format = Object.values(TranscriptFormat).includes(response?.transcript_format as never)
      ? response?.transcript_format as TranscriptFormatType
      : null;
    const source = Object.values(TranscriptSource).includes(response?.transcript_source as never)
      ? response?.transcript_source as TranscriptSourceType
      : null;
    const path = response?.path ?? response?.transcript_path ?? '';
    return new AgentTranscript(
      response?.worker_type ?? this.worker_type ?? '',
      entries,
      response?.session_id ?? this.session_id ?? '',
      {
        path,
        transcript_format: format,
        transcript_source: source,
      },
    );
  }

  // ─────────────────────────────────────────────────────────────────────────

  /** Internal references (not serialized) */
  _instructionFile?: InstructionFile;
  _context?: AgenticContext;

  /** Last error observed when ``workerStatus`` transitioned to a failure
   *  state. Set by ``_handleError``; never set autonomously by the SDK. */
  private _error: Error | null = null;

  /** History loading state */
  private _historyLoaded: boolean = false;
  private _historyLoading: Promise<void> | null = null;

  /**
   * True after the user explicitly stopped this process (``stop`` /
   * ``exit`` / ``close``) and before the next successful ``start``. Gates
   * the auto-recovery dispatcher so a deliberately stopped process is not
   * silently relaunched.
   */
  private _userInitiatedStop: boolean = false;

  constructor(entity: Partial<IAgenticProcess> = {}) {
    super(entity);
    this.instruction_content = entity.instruction_content;
    this.asset_ref = entity.asset_ref;
    this.context = entity.context;
    this.context_data = entity.context_data;
    this.favorite_index = entity.favorite_index;
    this.status = (entity.status as ProcessStatus) ?? ProcessStatus.NEW;
    this.workerStatus = (entity.worker_status as WorkerStatus) ?? WorkerStatus.INITIALIZING;
    this.session_id = entity.session_id;
    this.use_worker_history = entity.use_worker_history;
    this.shell_mode = entity.shell_mode;
    this.worker_type = entity.worker_type ?? null;
    this.process_type = entity.process_type ?? null;
    this.shell_id = entity.shell_id;
    this.visible = entity.visible;
    this.sidecar_shell_id = entity.sidecar_shell_id;
    this.auto_rename = entity.auto_rename ?? true;
    this.project_id = entity.project_id ?? null;
    this.collaboration_room_id = entity.collaboration_room_id ?? null;
    this.target_typeid_str = entity.target_typeid_str ?? null;
    this.exe_folder = entity.exe_folder ? FSRef.fromJson(entity.exe_folder) : null;
    this.input_folder = entity.input_folder ? FSRef.fromJson(entity.input_folder) : null;
    this.output_folder = entity.output_folder ? FSRef.fromJson(entity.output_folder) : null;
    this.assets_folder = entity.assets_folder ? FSRef.fromJson(entity.assets_folder) : null;
    this.plan_path = entity.plan_path ?? null;
  }

  // NOTE: project_id projection moved server-side. The base Python
  // ``Entity.get_implicit_private_context_entities`` projects project_id
  // for every entity with one; AgenticProcess inherits the projection
  // automatically. FE displays the merged ``private_context_entities``
  // from the wire as-is.

  // ── Field declarations (populated by constructor / wire data) ──────────────

  plan_path: string | null = null;

  /**
   * Get the instruction file (if set locally)
   */
  get instructionFile(): InstructionFile | undefined {
    return this._instructionFile;
  }

  /**
   * Get the workdir as a VFSPath if available.
   * Resolves plain machine paths against the current compute-node context.
   */
  get workDirVfs(): VFSPath | null {
    const contextWorkdir = this.workdir;
    if (!contextWorkdir) {
      return null;
    }

    // If it already looks like a VFS path, parse directly.
    if (contextWorkdir.includes(':/') || contextWorkdir.includes('-@') || contextWorkdir.startsWith('vfs://')) {
      return VFSPath.parse(contextWorkdir);
    }

    const computeNodeTypeId = dataContext.computeNode?.typeId;
    if (!computeNodeTypeId) {
      return VFSPath.parse(contextWorkdir);
    }

    try {
      return VFSPath.fromMachinePath(contextWorkdir, computeNodeTypeId);
    } catch {
      return VFSPath.parse(contextWorkdir);
    }
  }

  get shellEntity(): Shell | null {
    if (!this.shell_id) return null;
    return dataManager.getByTypeIdFromCache<Shell>(new TypeId(Shell.type, this.shell_id));
  }

  get compute_node_id(): string | null {
    return this.shellEntity?.compute_node_id ?? null;
  }

  get compute_node_uname(): string | null {
    return this.shellEntity?.compute_node_uname ?? null;
  }

  /**
   * Get the current stack frame (top-level variables).
   * This is a convenience accessor mirroring Python's state.stackFrame.
   */
  get stackFrame(): Record<string, unknown> {
    return {};
  }

  /**
   * Whether this process has reached a terminal worker_status (complete /
   * error / interrupted). Derived from ``workerStatus`` — the SDK keeps no
   * separate completion flag; backend's projection is the single source of
   * truth and we mirror it.
   */
  get completed(): boolean {
    return isWorkerTerminal(this.workerStatus);
  }

  /**
   * Error if execution failed, null otherwise.
   */
  get error(): Error | null {
    return this._error;
  }

  /**
   * Async iterator for streaming FlowData outputs.
   *
   * Yields FlowData as they arrive from the backend.
   * First yields any already-collected outputs, then waits for new ones.
   *
   * Mirrors Python's `async for data in process.output()` pattern.
   *
   * @example
   * ```typescript
   * for await (const flowData of process.output()) {
   *   console.log(`[${flowData.elementType}]`, flowData.data);
   * }
   * ```
   */
  async *output(): AsyncGenerator<FlowData, void, unknown> {
    // First yield all already-collected outputs from the flowDataStream
    for (const data of this.flowDataStream.items) {
      yield data;
    }

    // If the worker has already reached a terminal state, we're done.
    if (isWorkerTerminal(this.workerStatus)) {
      return;
    }

    // Wait for more outputs via event-driven promise queue
    const queue: FlowData[] = [];
    let resolver: ((v: FlowData | null) => void) | null = null;
    let completed = false;

    const dataHandler = (data: FlowData) => {
      if (resolver) {
        resolver(data);
        resolver = null;
      } else {
        queue.push(data);
      }
    };

    const completeHandler = () => {
      completed = true;
      if (resolver) {
        resolver(null);
        resolver = null;
      }
    };

    const errorHandler = () => {
      completed = true;
      if (resolver) {
        resolver(null);
        resolver = null;
      }
    };

    const unsubData = this.on('flow_data', dataHandler);
    const unsubComplete = this.on('complete', completeHandler);
    const unsubError = this.on('error', errorHandler);

    try {
      while (!completed) {
        // Check queue first
        const queued = queue.shift();
        if (queued !== undefined) {
          yield queued;
          continue;
        }

        // Wait for next event
        const data = await new Promise<FlowData | null>((r) => {
          resolver = r;
        });

        if (data === null) {
          break;
        }
        yield data;
      }
    } finally {
      unsubData();
      unsubComplete();
      unsubError();
    }
  }

  /**
   * Get all collected FlowData outputs.
   * Uses the inherited flowDataStream from APIEntity.
   */
  getOutputs(): readonly FlowData[] {
    return this.flowDataStream.items;
  }

  /**
   * Optimistically append a user message to the flow stream.
   * This avoids missing USER_MESSAGE when emitted before watchers connect.
   */
  appendUserMessage(content: string): void {
    const trimmed = content.trim();
    if (!trimmed) {
      return;
    }

    const existing = [...this.flowDataStream.items]
      .reverse()
      .find(
        (item) =>
          item.elementType === FlowElementTypes.USER_MESSAGE &&
          (item.attributes.role ?? '') === 'user' &&
          item.content === trimmed,
      );
    if (existing) {
      return;
    }

    const timestamp = new Date().toISOString();
    const userFlowData = FlowDataFactory.fromElementType(
      FlowElementTypes.USER_MESSAGE,
      trimmed,
      {
        role: 'user',
        t: timestamp,
      },
      true,
    );
    userFlowData.markReady();
    this.flowDataStream.ingest(userFlowData);
  }

  async reportEvent(
    name: AgenticProcessEventName,
    data: Record<string, unknown> = {},
  ): Promise<AgenticProcessReportEventResult> {
    const actionInfo = new ActionInfo('report_event', AgenticProcess.type, this.id, 'GET');
    actionInfo.subpath = name;
    const requestId =
      globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    actionInfo.queryParameters = {
      data: JSON.stringify(data),
      request_id: requestId,
    };
    return dataManager.callAction<void, AgenticProcessReportEventResult>(actionInfo);
  }

  /**
   * Load history from backend and populate the flowDataStream.
   *
   * This is called after reconnecting to a process to restore the
   * FlowData stream with historical data. Safe to call multiple times -
   * will only load once.
   *
   * @returns Promise that resolves when history is loaded
   */
  async loadHistory(options: { force?: boolean; onlyUserMessages?: boolean } = {}): Promise<void> {
    const { force = false, onlyUserMessages = false } = options;

    // Prevent duplicate loading unless forced
    if (this._historyLoaded && !force) {
      return;
    }

    // Return existing promise if already loading
    if (this._historyLoading) {
      return this._historyLoading;
    }

    this._historyLoading = (async () => {
      try {
        const actionInfo = new ActionInfo('get-history', AgenticProcess.type, this.id, 'GET');
        const response = await dataManager.callAction<void, HistoryResponse>(actionInfo);

        if (!response || !response.history) {
          return;
        }

        // Update session info
        this.session_id = response.session_id;
        this.use_worker_history = response.use_worker_history;

        // Convert history items to FlowData and append to stream
        const historyItems: FlowData[] = [];
        for (const item of response.history) {
          const flowData = FlowData.fromJSON({
            flow_value: item.flow_value,
            attributes: item.attributes,
            index: item.index,
            created_time: item.created_time,
          });
          if (onlyUserMessages) {
            const isUserMessage = flowData.elementType === 'user-message' || flowData.attributes.role === 'user';
            if (!isUserMessage) {
              continue;
            }
          }
          // Mark as ready (historical items are complete) and tag as History
          // so downstream consumers (e.g. useDerivedWorkerStatus) can distinguish
          // replayed events from live stream deltas and avoid mis-transitioning
          // the worker indicator back into THINKING on refresh.
          flowData.markReady();
          flowData.source = FlowDataSource.History;
          historyItems.push(flowData);
        }

        // Ingest history items to stream, skipping duplicates by elementType + role + content
        const existingKeys = new Set(
          this.flowDataStream.items.map((item) => {
            const role = item.attributes.role ?? '';
            return `${item.elementType}|${role}|${item.content ?? ''}`;
          }),
        );

        // Filter out duplicates (already-ingested items by element/role/content
        // signature) BEFORE ingesting so the batch only carries new items.
        const newItems: FlowData[] = [];
        for (const item of historyItems) {
          const role = item.attributes.role ?? '';
          const key = `${item.elementType}|${role}|${item.content ?? ''}`;
          if (existingKeys.has(key)) continue;
          existingKeys.add(key);
          newItems.push(item);
        }
        // Coalesce per-item `'data'` emissions into a single one so React
        // consumers (`useSyncExternalStore` via `useAgenticProcessStream` /
        // `useDerivedWorkerStatus` / `useEntityData`) re-render once per
        // loadHistory call instead of once per item — prevents 700+
        // notifications from blowing past React's nested-update budget.
        this.flowDataStream.ingestBatch(newItems);
        // Close any open groups after loading history
        this.flowDataStream.closeOpenGroups();

        // History replay can reveal that the worker already reached a
        // terminal state by the time we mounted. Fire the matching
        // handler so consumers waiting on the ``complete`` / ``error``
        // event resolve instead of hanging.
        if (isWorkerTerminal(this.workerStatus)) {
          if (this.workerStatus === WorkerStatus.COMPLETE) {
            this._handleComplete();
          } else {
            this._handleError(new Error(`Process ended with worker status: ${this.workerStatus}`));
          }
        }

        console.log(`[AgenticProcess] Loaded ${historyItems.length} history items for process ${this.id}`);
        this._historyLoaded = true;
      } catch (error) {
        console.error(`[AgenticProcess] Failed to load history for process ${this.id}:`, error);
        // Don't throw - history loading failure shouldn't break the app
      } finally {
        this._historyLoading = null;
      }
    })();

    return this._historyLoading;
  }

  /**
   * Whether history has been loaded from backend.
   */
  get historyLoaded(): boolean {
    return this._historyLoaded;
  }

  /**
   * Wait for process completion (complete or error event).
   *
   * @returns Promise that resolves when execution completes
   * @throws Error if execution fails
   */
  async waitForComplete(): Promise<void> {
    if (isWorkerTerminal(this.workerStatus)) {
      if (this._error) throw this._error;
      return;
    }

    return new Promise((resolve, reject) => {
      const completeHandler = () => {
        unsubError();
        resolve();
      };

      const errorHandler = (error: Error) => {
        unsubComplete();
        reject(error);
      };

      const unsubComplete = this.on('complete', completeHandler);
      const unsubError = this.on('error', errorHandler);
    });
  }

  // ============ Process Interpreter API ============

  /**
   * Execute an instruction on this process.
   *
   * This is the primary API for running instructions on an existing process.
   * The process must not be stopping or already executing work.
   *
   * @param instruction - The instruction text to execute
   * @param options - Execution options
   * @param options.sync - If true (default), wait for completion before returning
   * @returns Promise that resolves when instruction is queued (sync=false) or completed (sync=true)
   *
   * @example
   * ```typescript
   * const process = await createProcess(context);
   *
   * // Sync execution (default) - waits for completion
   * await process.execute("Remember the number 42");
   * await process.execute("What number did I ask you to remember?");
   *
   * // Async execution - returns immediately
   * await process.execute("Do something long", { sync: false });
   * // ... do other work ...
   * await process.wait();
   * ```
   */
  /**
   * Load an agent from a VFS path and embed it into this process.
   * Mirrors the Python `process.load_embedded_agent()` API.
   * The agent spec is merged into cli_config on the backend and persisted.
   */
  async loadEmbeddedAgent(sourcePath: string): Promise<void> {
    const actionInfo = new ActionInfo('load-embedded-agent', AgenticProcess.type, this.id, 'POST');
    actionInfo.bodyParameters = { asset_ref: sourcePath };
    await dataManager.callAction(actionInfo);
  }

  /**
   * Symlink a skill folder into this process's assets dir so Claude Code
   * discovers it at startup. `sourcePath` is the absolute path of the skill
   * folder (parent of SKILL.md). Live edits to the source SKILL.md flow
   * through to the next session — no re-materialization needed.
   */
  async loadEmbeddedSkill(sourcePath: string): Promise<void> {
    const actionInfo = new ActionInfo('load-embedded-skill', AgenticProcess.type, this.id, 'POST');
    actionInfo.bodyParameters = { asset_ref: sourcePath };
    await dataManager.callAction(actionInfo);
  }

  /**
   * Unified read-side view of every asset visible to this process.
   * Mirrors `flow_sdk.builtin.agentic_process.AgenticProcess.get_asset_descriptors`.
   *
   * The same asset may appear multiple times with different `source` values
   * (e.g. EMBEDDED + USER_DIR for a skill that's both materialized into the
   * process and globally discoverable).
   *
   * Currently filtered to ExecutableAssets (skills + agents).
   */
  async getAssets(): Promise<AssetDescriptor[]> {
    const actionInfo = new ActionInfo('get-assets', AgenticProcess.type, this.id, 'GET');
    const response = await dataManager.callAction<void, { assets?: AssetDescriptor[] }>(actionInfo);
    return response?.assets ?? [];
  }

  /**
   * Unified attach/detach/list for file-backed entities (agents, skills, …)
   * materialized under the process's assets dir and discovered by Claude via
   * ``--add-dir``. Mirrors Python ``process.attach_embedded_asset`` /
   * ``detach_embedded_asset`` / ``list_embedded_assets``.
   *
   * Pass a serialized TypeId (``agent-<id>`` / ``skill-<id>``) or the entity
   * itself — ``typeId.toString()`` is extracted automatically.
   */
  readonly embeddedAssets = {
    attach: async (entityOrRef: { typeId?: TypeId } | TypeId | string): Promise<void> => {
      const ref = this._coerceRef(entityOrRef);
      const actionInfo = new ActionInfo('attach-embedded-asset', AgenticProcess.type, this.id, 'POST');
      actionInfo.bodyParameters = { entity_ref: ref.toString() };
      await dataManager.callAction(actionInfo);
      // The WS broadcast lands embedded_asset_refs as plain stringified TypeIds
      // (the server serializes them that way); avoid duplicating by comparing
      // on the string form instead of property-by-property on TypeId.
      const refStr = ref.toString();
      const current = this.embedded_asset_refs ?? [];
      const has = current.some((r) => String(r) === refStr);
      if (!has) this.embedded_asset_refs = [...current, ref];
    },
    detach: async (entityOrRef: { typeId?: TypeId } | TypeId | string): Promise<void> => {
      const ref = this._coerceRef(entityOrRef);
      const actionInfo = new ActionInfo('detach-embedded-asset', AgenticProcess.type, this.id, 'POST');
      actionInfo.bodyParameters = { entity_ref: ref.toString() };
      await dataManager.callAction(actionInfo);
      const refStr = ref.toString();
      this.embedded_asset_refs = (this.embedded_asset_refs ?? [])
        .filter((r) => String(r) !== refStr);
    },
    list: (): TypeId[] => [...(this.embedded_asset_refs ?? [])],
  };

  /** Normalize the three accepted input shapes to a TypeId. */
  private _coerceRef(input: { typeId?: TypeId } | TypeId | string): TypeId {
    if (input instanceof TypeId) return input;
    if (typeof input === 'string') return new TypeId(input);
    if (input.typeId) return input.typeId;
    throw new Error('embeddedAssets: input must be TypeId, entity with typeId, or serialized string');
  }

  /**
   * Print-mode streaming prompt. Available on ``visible === false`` (print-mode)
   * processes created with ``outputFormat: "stream-json"`` on the AgenticContext.
   *
   * POSTs ``/agentic_process/<id>/prompt`` with ``{ message }``, consumes the
   * streaming XML response body via ``FlowStreamProcessor``, and ingests each
   * emitted FlowData into ``this.flowDataStream`` so the UI sees it via the
   * same hook pipeline (``useProcessStream``) the rest of the app already uses.
   *
   * PTY-interactive processes (visible=true) will 409 on this action — they
   * use ``inject``/``executeInstruction`` instead.
   */
  async prompt(text: string, abortController?: AbortController): Promise<void> {
    const { FlowStreamProcessor } = await import('../flow_processing/flow-stream-processor');
    const { FlowEvents } = await import('../flow_processing/flow-events');

    const ctrl = abortController ?? new AbortController();

    // Optimistic echo of the user turn into the stream.
    this.appendUserMessage(text);

    const actionInfo = new ActionInfo(
      'prompt',
      AgenticProcess.type,
      this.id,
      'POST',
      false,
      true, // streaming
      ctrl.signal,
    );
    actionInfo.bodyParameters = { message: text };

    const response = await dataManager.callAction<unknown, Response>(actionInfo);
    if (!response || !response.body) {
      throw new Error('[AgenticProcess.prompt] no streaming response body');
    }

    const processor = new FlowStreamProcessor();
    processor.on(FlowEvents.DATA, (fd: FlowData) => {
      try {
        this.flowDataStream.ingest(fd);
      } catch (err) {
        console.error('[AgenticProcess.prompt] ingest error', err);
      }
    });
    processor.on(FlowEvents.ERROR, (err) => {
      console.error('[AgenticProcess.prompt] processor error', err);
    });

    await processor.ingestStream(response.body.getReader(), ctrl);
  }

  /**
   * Cancel the in-flight prompt turn. Server-side SIGTERMs the subprocess with
   * a 5 s grace then SIGKILL; a final ``<flow-end>`` arrives on the stream.
   */
  async cancelPrompt(): Promise<void> {
    const actionInfo = new ActionInfo('cancel-prompt', AgenticProcess.type, this.id, 'POST');
    await dataManager.callAction(actionInfo);
  }

  async executeInstruction(
    instruction: string,
    options: { sync?: boolean; workerSessionId?: string } = {},
  ): Promise<void> {
    const { sync = true, workerSessionId } = options;

    if (this.status === ProcessStatus.STOPPING) {
      throw new Error('Process is stopping');
    }

    if (this.status === ProcessStatus.FAILED) {
      throw new Error('Process failed to start');
    }

    if (isWorkerRunning(this.workerStatus)) {
      throw new Error('Process is already running');
    }

    // Clear the cached error from any prior turn. We do NOT touch
    // ``workerStatus`` — that's backend-owned. ``headless_prompt`` on the
    // server flips its projection to ``running`` and broadcasts, and the
    // resulting entity-op is what the SDK mirrors as the new turn's edge.
    this._error = null;

    // Optimistically echo user message into the stream
    this.appendUserMessage(instruction);

    // Call backend execute action
    const actionInfo = new ActionInfo('execute', AgenticProcess.type, this.id, 'POST');
    actionInfo.bodyParameters = { instruction, ...(workerSessionId ? { worker_session_id: workerSessionId } : {}) };

    await dataManager.callAction(actionInfo);

    // If sync, wait for execution to complete
    if (sync) {
      await this.waitForExecutionComplete();
    }
  }

  /**
   * Wait for execution to complete.
   *
   * Listens for the ``complete`` / ``error`` events which fire when the
   * SDK observes ``workerStatus`` transitioning to a terminal value via
   * an entity-op broadcast. Backend is the sole authority on that
   * transition; the SDK only reacts.
   */
  private async waitForExecutionComplete(): Promise<void> {
    if (isWorkerTerminal(this.workerStatus)) {
      if (this._error) throw this._error;
      return;
    }

    return new Promise((resolve, reject) => {
      let resolved = false;

      const done = (result: 'resolve' | 'reject', error?: Error) => {
        if (resolved) return;
        resolved = true;
        unsubComplete();
        unsubError();
        if (result === 'resolve') {
          resolve();
        } else {
          reject(error ?? new Error('Unknown error'));
        }
      };

      const unsubComplete = this.on('complete', () => {
        done('resolve');
      });

      const unsubError = this.on('error', (err) => {
        done('reject', err instanceof Error ? err : new Error(String(err)));
      });

      // Race: a terminal broadcast could land between the entry check above
      // and listener installation. Re-check after subscribing.
      if (isWorkerTerminal(this.workerStatus)) {
        done(this._error ? 'reject' : 'resolve', this._error ?? undefined);
      }
    });
  }

  /**
   * Wait for the worker_status to reach a terminal state.
   *
   * Use this after async execute() calls to wait for completion.
   */
  async wait(): Promise<void> {
    if (isWorkerTerminal(this.workerStatus)) {
      return;
    }

    return new Promise((resolve, reject) => {
      const checkState = () => {
        if (this.workerStatus === WorkerStatus.COMPLETE) {
          unsubState();
          unsubError();
          resolve();
        } else if (this.workerStatus === WorkerStatus.ERROR) {
          unsubState();
          unsubError();
          reject(new Error(this._error?.message || 'Process error'));
        } else if (this.workerStatus === WorkerStatus.INTERRUPTED) {
          unsubState();
          unsubError();
          reject(new Error('Process was terminated'));
        } else if (this.status === ProcessStatus.FAILED) {
          unsubState();
          unsubError();
          reject(new Error(this._error?.message || 'Process failed'));
        }
      };

      const unsubState = this.on('state_change', checkState);
      const unsubError = this.on('error', (err) => {
        unsubState();
        unsubError();
        reject(err instanceof Error ? err : new Error(String(err)));
      });

      // Check current state immediately
      checkState();
    });
  }

  /**
   * Terminate this process.
   *
   * After exit, the worker is stopped and the lifecycle status is controlled by the backend.
   *
   * @example
   * ```typescript
   * const process = await createProcess(context);
   * await process.execute("Do something");
   * await process.exit(); // Cleanup
   * ```
   */
  async exit(): Promise<void> {
    if (!this.shell_id) return; // Nothing to exit

    // Mark this stop as user-initiated so the auto-recovery dispatcher does
    // not relaunch the worker between the optimistic CLOSING update and the
    // backend's eventual STOPPED/STOPPING write.
    this._userInitiatedStop = true;

    // Optimistically mark the shell CLOSING synchronously (no await) so the
    // loader's resolveDefaultShell sees it as non-alive and won't redirect back
    // to this tab while the exit API call is in-flight.
    const shell = Shell.getByIdFromCache(this.shell_id);
    if (shell) {
      shell.status = ShellStatus.CLOSING;
      dataManager.notifyEntityChanged(shell);
    }

    const actionInfo = new ActionInfo('exit', AgenticProcess.type, this.id, 'POST');
    await dataManager.callAction(actionInfo);

    // Shell entity is kept alive by the backend — do NOT call shell.close()
  }

  /**
   * Re-attach this process to a Project derived from its `workdir`.
   *
   * Calls the `recover-project` backend action which walks 3 phases (existing
   * exact-match → ~/.claude/projects materialization → fresh entity), repoints
   * `self.project_id`, saves on the server, and returns the recovered Project.
   * This method drops the recovered entity into the local `dataManager` cache
   * and updates `this.project_id` (no save — backend already saved).
   *
   * Used by the route loader on a 404 from the project context fetch.
   */
  async recoverProject(): Promise<import('../entities/project').Project> {
    const { Project } = await import('../entities/project');
    const action = new ActionInfo('recover-project', AgenticProcess.type, this.id, 'POST');
    const response = await dataManager.callAction<void, { project: unknown }>(action);
    if (!response?.project) {
      throw new Error('recover-project returned no project entity');
    }
    const project = dataManager.updateEntityFromJson<import('../entities/project').Project>(
      response.project as Record<string, unknown>,
    );
    this.project_id = project.id;
    return project;
  }

  /**
   * Permanent teardown: kill worker + delete shell entity.
   * Use for "close tab" — shell is gone after this call.
   */
  async close(): Promise<void> {
    if (this.status === ProcessStatus.STOPPING || this.status === ProcessStatus.STOPPED) return;

    // Permanent teardown — deregister so neither the poll nor the
    // on_reconnected dispatcher tries to relaunch this process.
    this._userInitiatedStop = true;
    _agenticProcessRegistry.delete(this);

    if (this.shell_id) {
      const shell = Shell.getByIdFromCache(this.shell_id);
      if (shell) {
        shell.status = ShellStatus.CLOSING;
        dataManager.notifyEntityChanged(shell);
      }
    }

    const actionInfo = new ActionInfo('close', AgenticProcess.type, this.id, 'POST');
    await dataManager.callAction(actionInfo);

    // Dispose frontend PTY client — backend already deleted the shell entity.
    if (this.shell_id) {
      const shell = Shell.getByIdFromCache(this.shell_id);
      if (shell) await shell.close().catch(() => {});
    }
  }

  // ============ Shell Lifecycle API ============

  /**
   * Start (or reopen) this AgenticProcess.
   *
   * Calls the backend `open` action which builds the full claude command
   * server-side and opens a Shell-owned PTY. Handles all cases:
   * fresh start, reopen after restart (resumes Claude), or no-op if PTY alive.
   *
   * @param options - Optional instruction to execute
   * @returns Shell session ID and session ID
   */
  async start(options?: {
    instruction?: string;
    visible?: boolean;
    ptyTimeout?: number;
    /** Initial PTY dimensions. Authoritative resize is issued by the
     * InteractiveTerminal once xterm has fitted; this seed exists so the
     * worker's first paint isn't wrapped at 80 cols on a wide viewport. */
    cols?: number;
    rows?: number;
  }): Promise<boolean> {
    const { Shell } = await import('../entities/shell');
    // No client-side STOPPING guard. The server's ``open`` action runs
    // ``reap_if_orphaned()`` at entry: if the row is stuck in STOPPING with
    // a dead worker, it's reset to STOPPED and the start proceeds normally.
    // If it's a *live* transitioner (within the 10s grace), the server will
    // refuse with a useful response — let the server be the authority.
    //
    // No client-side lifecycle fast path. The backend ``open`` action is the
    // single oracle for reattach-vs-recover-vs-fresh. The dedupe that *did*
    // matter — "I'm already on this same pty_id, don't reopen the WS" — is
    // already enforced inside ``PtyConnection.attach`` via the
    // ``_attachedPtyId`` early-return and the in-flight ``_attachPromise``
    // guard, so removing the short-circuit here costs nothing on tab-switch
    // performance and removes the empty-shell-after-refresh failure mode
    // (the cached ``status === RUNNING`` could outlive the actual worker).
    const actionInfo = new ActionInfo('open', AgenticProcess.type, this.id, 'POST');
    actionInfo.bodyParameters = options ?? {};
    const result = await dataManager.callAction<
      unknown,
      { shell_id: string; pty_id: string; session_id: string | null; status?: string; shell: Record<string, unknown> } | null
    >(actionInfo);
    if (!result) throw new Error('Process could not be opened (process may be terminated)');
    if (result.status) {
      this.status = result.status as ProcessStatus;
    }
    this.shell_id = result.shell_id;
    this.session_id = result.session_id;
    dataManager.updateEntityFromJson(result.shell);
    const shell = await dataManager.getByTypeId<Shell>(new TypeId(Shell.type, result.shell_id));
    if (!shell) throw new Error(`Shell ${result.shell_id} not found after start()`);
    shell.pty_pid = result.pty_id;
    // Sync PtyConnection identifiers before attaching (guard: fakes in tests may lack ptyConnection).
    if (shell.ptyConnection) {
      shell.ptyConnection.shellId = shell.id;
      if (shell.compute_node_id) shell.ptyConnection.computeNodeId = shell.compute_node_id;
    }
    await shell.attachPty({
      cols: options?.cols ?? Shell.DEFAULT_COLS,
      rows: options?.rows ?? Shell.DEFAULT_ROWS,
      timeout: options?.ptyTimeout,
      ptyId: result.pty_id,
    });
    // Successful open clears any prior user-stop intent and registers this
    // process for auto-recovery (poll + on_reconnected dispatcher).
    this._userInitiatedStop = false;
    _agenticProcessRegistry.add(this);
    _ensureAgenticStaticListeners();
    return true;
  }

  /**
   * Read-only OS-level status snapshot. Calls the backend ``os-status``
   * action which checks the PTY session liveness on the compute node and
   * the worker PID via psutil + cmdline match. Use this whenever you need
   * ground truth about whether the process is actually running — never
   * infer it from the cached ``status`` field.
   */
  async getOsStatus(): Promise<AgenticProcessOSStatus> {
    const actionInfo = new ActionInfo('os-status', AgenticProcess.type, this.id, 'GET');
    const result = await dataManager.callAction<unknown, AgenticProcessOSStatus>(actionInfo);
    if (!result) throw new Error('os-status returned no data');
    return result;
  }

  /**
   * True iff the backend reports both an alive PTY session and a live
   * worker PID for this process. Sugar over ``getOsStatus().ready``.
   */
  async isAlive(): Promise<boolean> {
    const status = await this.getOsStatus();
    return status.ready;
  }

  /** True iff this process is a valid target for an auto-recovery sweep.
   *  Centralizes the skip predicates so the standalone ``reconnect()`` and
   *  the batched ``reconnectFromOsStatus(...)`` agree on which states are
   *  recovery-eligible.
   *
   *   - ``_userInitiatedStop``: user explicitly stopped this process.
   *   - ``STARTING`` / ``STOPPING``: mid-transition — let the in-flight
   *     call finish first.
   *   - ``FAILED``: relaunching would loop because the worker can't start
   *     with the current ``cli_options``.
   */
  private _isRecoveryEligible(): boolean {
    if (this._userInitiatedStop) return false;
    if (this.status === ProcessStatus.STARTING || this.status === ProcessStatus.STOPPING) return false;
    if (this.status === ProcessStatus.FAILED) return false;
    return true;
  }

  /**
   * Decide and run recovery against a pre-fetched os-status payload. This is
   * the per-AP half of the batched auto-recovery sweep — the dispatcher
   * makes one ``compute_node/os-status-batch`` call and fans the results
   * back out via this method, so no extra GETs are issued.
   *
   * Concurrent triggers (poll tick arriving while ``on_reconnected`` is in
   * flight) converge: the backend's per-process ``_OPEN_LOCKS`` mutex
   * serializes ``open``, and a redundant ``start()`` is a cheap no-op once
   * the first recovery has won.
   *
   * @returns true iff a recovery ``start()`` was issued.
   */
  async reconnectFromOsStatus(status: AgenticProcessOSStatus): Promise<boolean> {
    if (!this._isRecoveryEligible()) return false;
    if (status.ready) return false;
    await this.start({ visible: this.visible });
    return true;
  }

  /**
   * Standalone auto-recovery entry point. Issues its own ``os-status`` GET
   * and applies the decision. Prefer the batched dispatcher
   * (``_dispatchRecoverySweep``) for multi-AP sweeps; this method is kept
   * for the early-bootstrap fallback (no compute_node context yet) and
   * external callers that want a one-shot reconnect for a single process.
   *
   * @returns true iff a recovery ``start()`` was issued.
   */
  async reconnect(): Promise<boolean> {
    if (!this._isRecoveryEligible()) return false;
    const status = await this.getOsStatus();
    return this.reconnectFromOsStatus(status);
  }

  /**
   * Fork this session into a new sibling AgenticProcess.
   *
   * Creates a new process that resumes from this session's conversation history
   * but diverges into a fresh session ID — equivalent to running:
   *   claude --resume <this.session_id> --fork-session
   *
   * @param visible - Whether the new process should appear in the tabs view (default: false).
   *                  Pass true when forking from the UI toolbar.
   * @returns The new AgenticProcess, already opened with a live PTY.
   */
  async fork(visible = false): Promise<AgenticProcess> {
    const actionInfo = new ActionInfo('fork', AgenticProcess.type, this.id, 'POST');
    actionInfo.bodyParameters = { visible };
    const data = await dataManager.callAction<{ visible: boolean }, Record<string, unknown>>(actionInfo);
    if (!data?.id) throw new Error('Fork failed: backend returned no process data');
    dataManager.updateEntityFromJson(data);
    const newProcess = await dataManager.getByTypeId<AgenticProcess>(new TypeId(AgenticProcess.type, data.id as string));
    if (!newProcess) throw new Error(`Fork failed: new process ${data.id} not found after registration`);
    await newProcess.start();
    return newProcess;
  }

  /**
   * Start a CollaborationRoom around this process — creates a fresh room on
   * the project and binds this process to it.
   */
  async createCollaborationRoom(
    hostName: string,
    options?: { hostMemberId?: string; name?: string | null },
  ): Promise<import('../entities/collaboration-room').CollaborationRoom> {
    const { CollaborationRoom } = await import('../entities/collaboration-room');
    const room = await CollaborationRoom.create({
      projectId: this.project_id ?? undefined,
      hostName,
      hostMemberId: options?.hostMemberId,
      name: options?.name ?? null,
    });
    // Bind this process to the new room on both ends.
    this.collaboration_room_id = room.id;
    await this.save();
    try {
      await room.addProcess(this.id);
    } catch (err) {
      console.warn('[AgenticProcess.createCollaborationRoom] addProcess failed', err);
    }
    return room;
  }

  /**
   * Stop the current shell session while keeping the shell entity available for reuse.
   *
   * Calls the backend exit action which kills the worker and PTY but
   * preserves the shell entity. The session_id is preserved so the
   * process can be resumed later via start().
   */
  async stop(): Promise<void> {
    await this.exit();
  }

  /**
   * Stop the current shell session and start a new one, preserving session history.
   * Emits 'restarted' so the terminal can clear and re-attach.
   */
  async restart(): Promise<void> {
    if (this.shell_id) await this.stop();
    await this.start();
    this.emit('restarted', { process: this });
  }

  /**
   * Write raw text to the live PTY stdin.
   * The shell must have an active PTY (call start() first).
   *
   * @param text - Text to send (newline appended automatically)
   */
  async sendInput(text: string): Promise<void> {
    if (!this.shell_id) throw new Error('[AgenticProcess.sendInput] No shell linked to this process');
    const pty = this.ptyConnection;
    if (pty) {
      await pty.sendInput(text + '\n');
      return;
    }
    // Fallback: shell not yet in cache — load it and delegate
    const { Shell } = await import('../entities/shell');
    const typeId = new TypeId(Shell.type, this.shell_id);
    const shell = await dataManager.getByTypeId<Shell>(typeId);
    if (!shell) throw new Error(`[AgenticProcess.sendInput] Shell ${this.shell_id} not found`);
    await shell.ptyConnection.sendInput(text + '\n');
  }

  /**
   * @deprecated Use executeInstruction() instead. Will be removed in future version.
   */
  async continue(command: string): Promise<AgenticProcess> {
    await this.executeInstruction(AgenticProcess._wrapInAmd(command), { sync: false });
    return this;
  }

  /**
   * Inject a new instruction into the process's injected queue.
   *
   * The instruction is added to the backend's injected queue and will
   * be executed after all file-based instructions complete.
   *
   * @param instruction - The instruction text to inject
   * @returns Object with instructionId and updated queue size
   *
   * @example
   * ```typescript
   * const { process } = await AgenticProcess.spawn({ workdir }, { instruction: 'First task' });
   *
   * // Inject additional instructions during execution
   * const result = await process.inject("Now do another task");
   * console.log('Injected instruction:', result.instructionId);
   * ```
   */
  async inject(instruction: string): Promise<{ instructionId: string; injectedQueueSize: number }> {
    const actionInfo = new ActionInfo('control', AgenticProcess.type, this.id, 'POST');
    actionInfo.subpath = '/inject';
    actionInfo.bodyParameters = { message: instruction };

    const result = await dataManager.callAction<unknown, { injected: boolean; message_length: number }>(actionInfo);

    // Generate a client-side instruction ID since backend doesn't return one
    const instructionId = `instr_${Date.now().toString(36)}`;

    return {
      instructionId,
      injectedQueueSize: result.message_length,
    };
  }

  /**
   * Execute one instruction and yield its FlowData.
   *
   * This method waits for the next instruction to execute and yields
   * all FlowData generated by that single instruction.
   *
   * Note: This is a simplified step API for client-side use. The actual
   * step execution happens on the backend; this method streams the results.
   *
   * @example
   * ```typescript
   * const process = await processor.execute("First task", context);
   *
   * // Execute first instruction
   * for await (const data of process.step()) {
   *   console.log('Step 1:', data);
   * }
   *
   * // Inject and execute second instruction
   * await process.inject("Second task");
   * for await (const data of process.step()) {
   *   console.log('Step 2:', data);
   * }
   * ```
   */
  async *step(): AsyncGenerator<FlowData, void, unknown> {
    // Wait for flow data until the process completes
    const queue: FlowData[] = [];
    let resolver: ((v: FlowData | null) => void) | null = null;
    let stepComplete = false;

    const dataHandler = (data: FlowData) => {
      if (resolver) {
        resolver(data);
        resolver = null;
      } else {
        queue.push(data);
      }
    };

    const stateHandler = () => {
      if (isWorkerTerminal(this.workerStatus)) {
        stepComplete = true;
        if (resolver) {
          resolver(null);
          resolver = null;
        }
      }
    };

    const completeHandler = () => {
      stepComplete = true;
      if (resolver) {
        resolver(null);
        resolver = null;
      }
    };

    const unsubData = this.on('flow_data', dataHandler);
    const unsubState = this.on('state_change', stateHandler);
    const unsubComplete = this.on('complete', completeHandler);

    try {
      while (!stepComplete) {
        // Check queue first
        const queued = queue.shift();
        if (queued !== undefined) {
          yield queued;
          continue;
        }

        // Worker already terminal — drain and exit.
        if (isWorkerTerminal(this.workerStatus)) {
          break;
        }

        // Wait for next event
        const data = await new Promise<FlowData | null>((r) => {
          resolver = r;
        });

        if (data === null) {
          break;
        }
        yield data;
      }
    } finally {
      unsubData();
      unsubState();
      unsubComplete();
    }
  }

  // ============ Internal Methods ============

  /**
   * Handle incoming FlowData.
   * Note: Storage and 'flow_data' emit are handled by base class handleFlowData().
   * This method handles process-specific logic including state updates from FlowData
   * (following Flow's pattern of state management via FlowData messages).
   * @internal
   */
  /**
   * Called by the store when the backend pushes an entity update via WebSocket.
   * Propagates state changes (including COMPLETE) so output() terminates correctly.
   *
   * The ``state_change`` event carries a delta payload:
   *   { field: 'status' | 'workerStatus', oldValue, newValue }
   * so subscribers can distinguish lifecycle transitions from worker-status updates
   * without re-reading the entity.
   * @internal
   */
  protected onEntityUpdate(data: Partial<IAgenticProcess>): void {
    // Skip no-op transitions: castAndDeepAssign() runs this hook for every
    // WS entity-op AND for every REST-response write-through, so the same
    // status often arrives many times. Without the equality guard, downstream
    // `state_change` listeners (ProcessToolbar, useProcessState, useActiveTerminals)
    // would re-render at the broadcast frequency even when nothing changed.
    if (data.status && data.status !== this.status) {
      const oldStatus = this.status;
      this.status = data.status as ProcessStatus;
      this.emit('state_change', {
        field: 'status',
        oldValue: oldStatus,
        newValue: this.status,
      });
      // Named transition event — listener signature: (newValue, oldValue) => void.
      // Note: ``Shell`` also emits ``'status'`` for WS connection state — different
      // object, benign name overlap.
      this.emit('status', this.status, oldStatus);
      if (this.status === ProcessStatus.FAILED && !isWorkerTerminal(this.workerStatus)) {
        this._handleError(new Error(`Process ended with lifecycle status: ${this.status}`));
      }
    }
    if (data.worker_status && data.worker_status !== this.workerStatus) {
      const oldWorker = this.workerStatus;
      this.workerStatus = data.worker_status as WorkerStatus;
      this.emit('state_change', {
        field: 'workerStatus',
        oldValue: oldWorker,
        newValue: this.workerStatus,
      });
      if (this.workerStatus === WorkerStatus.COMPLETE) {
        this._handleComplete();
      } else if (this.workerStatus === WorkerStatus.ERROR || this.workerStatus === WorkerStatus.INTERRUPTED) {
        this._handleError(new Error(`Process ended with worker status: ${this.workerStatus}`));
      }
    }
  }

  /**
   * Local-side reaction to ``workerStatus`` transitioning to COMPLETE.
   * Frontend does NOT decide completion; backend's projection does. This
   * just closes the stream and fires the ``complete`` event so consumers
   * (``output()``, ``waitForExecutionComplete``) can resolve.
   *
   * Caller contract: only invoke on a real transition into COMPLETE. The
   * call site in ``onEntityUpdate`` is gated by ``newValue !== oldValue`` so
   * this is naturally one-per-edge.
   * @internal
   */
  _handleComplete(): void {
    this.flowDataStream.closeOpenGroups();
    this.flowDataStream.markComplete();
    this.emit('complete');
  }

  /**
   * Local-side reaction to ``workerStatus`` transitioning to a failure
   * state. Same authority model as ``_handleComplete``: backend decides;
   * SDK reacts.
   * @internal
   */
  _handleError(error: Error): void {
    this._error = error;
    this.emit('error', error);
  }

  /**
   * Execute a plan file in the active Claude PTY session.
   * @param filePath - Absolute path to the plan file
   * @param options - Optional options (e.g., clearContext to inject /clear first)
   */
  async executePlan(filePath: string, options?: { clearContext?: boolean }): Promise<void> {
    const actionInfo = new ActionInfo('execute-plan', AgenticProcess.type, this.id, 'POST');
    actionInfo.bodyParameters = { file_path: filePath, clear_context: options?.clearContext };
    return dataManager.callAction(actionInfo);
  }

  /**
   * Update a plan file based on <plan-note> annotations.
   * @param filePath - Absolute path to the plan file
   */
  async updatePlan(filePath: string): Promise<void> {
    const actionInfo = new ActionInfo('update-plan', AgenticProcess.type, this.id, 'POST');
    actionInfo.bodyParameters = { file_path: filePath };
    return dataManager.callAction<void, void>(actionInfo);
  }
}
