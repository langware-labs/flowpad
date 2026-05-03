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
import { ProcessIconKey, ProcessStatus, WorkerStatus, isWorkerRunning, isWorkerTerminal } from './agentic-types';

/**
 * Result returned by AgenticProcess.spawn().
 */
export interface SpawnResult {
  process: AgenticProcess;
  /** Set in PTY mode */
  shell?: Shell;
  /** Set in both modes */
  workerSessionId?: string;
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

/**
 * Interface for AgenticProcess entity data
 */
export interface IAgenticProcess extends IEntity {
  instruction_content?: string;
  asset_ref?: string;
  workdir?: string | null;
  context_data?: Record<string, unknown>;
  context_entities?: TypeId[];
  favorite_index?: number | null;
  readonly status?: ProcessStatus;
  readonly worker_status?: WorkerStatus;
  session_id?: string | null;
  use_worker_history?: boolean;
  /** False=direct PTY spawn (default), True=legacy zsh intermediary */
  shell_mode?: boolean;
  /** CLI worker vendor (e.g. 'claude', 'codex'). Drives icon selection. */
  worker_type?: string | null;
  /** Shell entity ID linked to this process */
  shell_id?: string | null;
  /** Whether this process is visible in the tabs view */
  visible?: boolean;
  /** Sidecar plain shell PTY session ID */
  sidecar_shell_id?: string | null;
  /**
   * Derived: true when the worker is ready for a new user prompt.
   * Computed server-side via ``is_ready_for_input``. Read-only on the wire.
   */
  ready_for_input?: boolean;
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
  /** VFS path the process is keyed to. Either an entity TypeId ("type-id") for entity-scoped chats, or "<typeid>/<sub_path>" for surface-scoped chats (e.g. per-doc chat keyed on the file path). */
  target_vfs_path?: string | null;
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
   * Open (or create) an AgenticProcess for a Claude CLI session ID.
   *
   * Uses ComputeNode.upsertSessionProcess to find an existing process linked
   * to this session, or create one if none exists (without starting a PTY).
   * Returns the process so the caller can navigate to its dockPointer.
   *
   * @param sessionId - Claude CLI session UUID
   */
  static async open(sessionId: string): Promise<AgenticProcess> {
    const { dataContext } = await import('../FlowSync/context');
    const computeNode = dataContext.computeNode;
    if (!computeNode) throw new Error('[AgenticProcess.open] No compute node');
    const { processId } = await computeNode.upsertSessionProcess(sessionId);
    const process = await AgenticProcess.getById(processId);
    if (!process) throw new Error(`[AgenticProcess.open] Process ${processId} not found after upsert`);
    return process;
  }

  /**
   * Find or create an AgenticProcess by worker session ID.
   * Uses upsertSessionProcess — returns the existing process if one already
   * has this session_id, otherwise creates a new one.
   *
   * @param workerType - 'claude' (reserved for future worker types)
   * @param sessionId  - The Claude CLI session UUID
   */
  static async fromWorkerSessionId(workerType: 'claude', sessionId: string): Promise<AgenticProcess> {
    return AgenticProcess.open(sessionId);
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
   * Get or create an AgenticProcess linked to a Claude CLI session.
   * Resolves the session's working directory from ClaudeSessionRecord if not provided.
   * Sets session_id so the process can be resumed via start().
   *
   * @param sessionId - The Claude CLI session UUID
   * @param cwd - Optional working directory (resolved from session record if omitted)
   */
  static async fromClaudeSession(sessionId: string, cwd?: string): Promise<AgenticProcess> {
    const { dataContext } = await import('../FlowSync/context');
    const computeNode = dataContext.computeNode;
    if (!computeNode) throw new Error('[AgenticProcess.fromClaudeSession] No compute node');

    // Resolve workdir from the session record on disk.
    // Best-effort: empty sessions have no JSONL yet, so cwd may be null.
    // upsertSessionProcess is idempotent — if the process already exists it is
    // returned immediately without needing workdir at all.
    let resolvedCwd = cwd;
    if (!resolvedCwd) {
      const { ClaudeSessionRecord } = await import('../resource_management/fs_records/claude/claude-session.js');
      const record = await ClaudeSessionRecord.discover(sessionId).catch(() => null);
      resolvedCwd = record?.cwd ?? undefined;
    }

    // upsertSessionProcess is idempotent: finds existing process or creates a new one.
    // Backend sets cli_config.resume=true if the transcript exists on disk.
    const { processId } = await computeNode.upsertSessionProcess(sessionId, {
      ...(resolvedCwd ? { workdir: resolvedCwd } : {}),
      projectId: dataContext.project?.id,
    });
    const process = await AgenticProcess.getById(processId);
    if (!process) throw new Error(`[AgenticProcess.fromClaudeSession] Process ${processId} not found`);
    return process;
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

  get dockPointer(): DockPointerData {
    return new DockPointerData(ViewType.SHELL, this.typeId?.toString());
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

  get searchDockPointer(): DockPointerData {
    if (this.session_id && this.project_encoded_name) {
      return new DockPointerData(ViewType.LENS, `claude/transcript/${this.project_encoded_name}/${this.session_id}`);
    }
    return this.dockPointer;
  }

  /** Instruction content being executed */
  instruction_content?: string;

  /** Source VFS path of the executed file */
  asset_ref?: string;

  /** Persisted context data for session restoration */
  context_data?: Record<string, unknown>;

  /** TypeIds of entities this process is contextually about (task / conversation / spec / project / …). */
  context_entities?: TypeId[];

  /** Optional pinning index for tab ordering */
  favorite_index?: number | null;

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

  /** Encoded project path for transcript navigation */
  project_encoded_name?: string | null;

  /** Whether worker manages its own history */
  use_worker_history?: boolean;

  /** False=direct PTY spawn (default), True=legacy zsh intermediary */
  shell_mode?: boolean;

  /** CLI worker vendor (e.g. 'claude', 'codex'). Drives icon selection. */
  worker_type?: string | null;

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

  /** VFS path the process is keyed to. Either an entity TypeId ("type-id") for entity-scoped chats, or "<typeid>/<sub_path>" for surface-scoped chats (e.g. per-doc chat keyed on the file path). */
  target_vfs_path: string | null = null;

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
    await this.callAction('add-dir', { path });
    this.additional_dirs = [...(this.additional_dirs ?? []), path];
  }

  async shell(): Promise<Shell | null> {
    if (!this.shell_id) return null;
    const { Shell } = await import('../entities/shell');
    return Shell.getById(this.shell_id);
  }

  /** The PTY connection for this process — delegates to the linked Shell. */
  get ptyConnection(): import('../services/shell/ptyConnection').PtyConnection | undefined {
    if (!this.shell_id) return undefined;
    const entity = dataManager.getByTypeIdFromCache(new TypeId('shell', this.shell_id)) as any;
    return entity?.ptyConnection;
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
   * Registers a regex trigger over the shell's line stream looking for
   * ``plan*.md`` mentions. When the regex matches:
   *
   * - With ``validate: false`` (default), ``handler`` is called with the
   *   matched line.
   * - With ``validate: true``, the process calls ``getPlan()`` and passes
   *   the resolved ``Markdown`` entity (or ``null`` if resolution failed)
   *   to ``handler``.
   *
   * Returns an unsubscribe function. The trigger only fires while the
   * subscription is alive; the persisted ``plan_path`` field is updated
   * server-side regardless of subscriptions when ``getPlan()`` runs.
   */
  onPlan<T = string | null>(
    options: { validate?: boolean },
    handler: (payload: T) => void,
  ): () => void {
    const validate = options.validate ?? false;
    let unsubShell: (() => void) | undefined;
    void (async () => {
      const sh = await this.shell();
      if (!sh) return;
      const pattern = /plan[\w-]*\.md/i;
      unsubShell = sh.addTrigger({
        pattern,
        label: 'plan-detection',
        onMatch: async (line) => {
          if (validate) {
            const md = await this.getPlan();
            handler(md as unknown as T);
          } else {
            handler(line as unknown as T);
          }
        },
      });
    })();
    return () => unsubShell?.();
  }

  /**
   * Fetch the plan as a Markdown entity.
   *
   * Server-side resolves the plan file path from ``plan_path`` (preferred)
   * or by scanning the transcript for the latest ``ExitPlanMode.planFilePath``,
   * reads the file, builds a saved+indexed ``Markdown`` entity, and returns
   * it. Returns ``null`` if no plan has been produced yet.
   */
  async getPlan(): Promise<import('../entities/markdown.js').Markdown | null> {
    const actionInfo = new ActionInfo('get-plan', AgenticProcess.type, this.id, 'POST');
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

  // ─────────────────────────────────────────────────────────────────────────

  /** Internal references (not serialized) */
  _instructionFile?: InstructionFile;
  _context?: AgenticContext;

  /** Completion state */
  private _completed: boolean = false;
  private _error: Error | null = null;

  /** History loading state */
  private _historyLoaded: boolean = false;
  private _historyLoading: Promise<void> | null = null;

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
    this.shell_id = entity.shell_id;
    this.visible = entity.visible;
    this.sidecar_shell_id = entity.sidecar_shell_id;
    this.collaboration_room_id = entity.collaboration_room_id ?? null;
    this.target_vfs_path = entity.target_vfs_path ?? null;
    this.exe_folder = entity.exe_folder ? FSRef.fromJson(entity.exe_folder) : null;
    this.input_folder = entity.input_folder ? FSRef.fromJson(entity.input_folder) : null;
    this.output_folder = entity.output_folder ? FSRef.fromJson(entity.output_folder) : null;
    this.assets_folder = entity.assets_folder ? FSRef.fromJson(entity.assets_folder) : null;
    this.plan_path = entity.plan_path ?? null;
  }

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
   * Whether this process has completed execution.
   */
  get completed(): boolean {
    return this._completed;
  }

  /**
   * Error if execution failed, null otherwise.
   */
  get error(): Error | null {
    return this._error;
  }

  /**
   * Handle incoming FlowData from backend entity notification.
   */
  handleFlowData(flowData: FlowData): void {
    super.handleFlowData(flowData);
    this._handleFlowData(flowData);
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

    // If already completed, we're done
    if (this._completed) {
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

        // Check if the worker already reached a terminal state.
        if (isWorkerTerminal(this.workerStatus)) {
          if (this.workerStatus === WorkerStatus.COMPLETE) {
            this._markComplete();
          } else {
            this._markError(new Error(`Process ended with worker status: ${this.workerStatus}`));
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
    if (this._completed) {
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
      const current = this.embedded_asset_refs ?? [];
      const has = current.some((r) => r.type === ref.type && r.id === ref.id);
      if (!has) this.embedded_asset_refs = [...current, ref];
    },
    detach: async (entityOrRef: { typeId?: TypeId } | TypeId | string): Promise<void> => {
      const ref = this._coerceRef(entityOrRef);
      const actionInfo = new ActionInfo('detach-embedded-asset', AgenticProcess.type, this.id, 'POST');
      actionInfo.bodyParameters = { entity_ref: ref.toString() };
      await dataManager.callAction(actionInfo);
      this.embedded_asset_refs = (this.embedded_asset_refs ?? [])
        .filter((r) => !(r.type === ref.type && r.id === ref.id));
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
        this._handleFlowData(fd);
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

    // Reset completion flag for new instruction (multi-turn support)
    this._completed = false;
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
   * Listens for the 'complete' event which is emitted when status FlowData
   * with complete=true is received (following Flow's pattern of state via FlowData).
   */
  private async waitForExecutionComplete(): Promise<void> {
    // If already completed, return immediately
    if (this._completed) {
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

      // Listen for completion event (emitted by _handleFlowData when status with complete=true is received)
      const unsubComplete = this.on('complete', () => {
        done('resolve');
      });

      const unsubError = this.on('error', (err) => {
        done('reject', err instanceof Error ? err : new Error(String(err)));
      });

      // Check if already completed (race condition safety)
      if (this._completed) {
        done('resolve');
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
    if (this.status === ProcessStatus.STOPPING) {
      throw new Error('Process is stopping');
    }

    // Fast path: if this process is already LIVE, its shell is cached, and the PTY is fully
    // attached in this client, skip the backend `open` round-trip entirely. Tab switches
    // between live sessions hit this path. Instructions must always go to the backend,
    // so we only short-circuit when no instruction is provided.
    // Requires the Shell entity to already be in cache AND its ptyConnection to be
    // attached to the current pty_pid. That holds for repeat visits to a tab during
    // the same app session; first visit still pays the full open + attach round-trip.
    if (
      this.status === ProcessStatus.RUNNING &&
      this.shell_id &&
      !options?.instruction
    ) {
      const cachedShell = dataManager.getByTypeIdFromCache<Shell>(new TypeId(Shell.type, this.shell_id));
      if (cachedShell && cachedShell.pty_pid && cachedShell.ptyConnection?.isAttachedTo(cachedShell.pty_pid)) {
        return true;
      }
    }

    const actionInfo = new ActionInfo('open', AgenticProcess.type, this.id, 'POST');
    actionInfo.bodyParameters = options ?? {};
    const result = await dataManager.callAction<
      unknown,
      { shell_id: string; pty_id: string; session_id: string; status?: string; shell: Record<string, unknown> } | null
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
    return true;
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
      if (this._completed) {
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

        // If already completed, we're done
        if (this._completed) {
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
  _handleFlowData(data: FlowData): void {
    const elementType = data.attributes?.['element-type'];
    const isComplete = data.attributes?.['complete'] === 'true';

    if (elementType === 'status' && typeof data.data === 'object' && data.data !== null) {
      const statusData = data.data as Record<string, unknown>;
      if (statusData.status && typeof statusData.status === 'string') {
        const oldWorker = this.workerStatus;
        this.workerStatus = statusData.status as WorkerStatus;
        this.emit('state_change', {
          field: 'workerStatus',
          oldValue: oldWorker,
          newValue: this.workerStatus,
        });
        if (this.workerStatus === WorkerStatus.ERROR || this.workerStatus === WorkerStatus.INTERRUPTED) {
          this._markError(new Error(`Process ended with worker status: ${this.workerStatus}`));
        }
      }
    }

    if (elementType === 'status' && isComplete) {
      this._markComplete();
    }
  }

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
    if (data.status) {
      const oldStatus = this.status;
      this.status = data.status as ProcessStatus;
      this.emit('state_change', {
        field: 'status',
        oldValue: oldStatus,
        newValue: this.status,
      });
      if (this.status === ProcessStatus.FAILED && !isWorkerTerminal(this.workerStatus)) {
        this._markError(new Error(`Process ended with lifecycle status: ${this.status}`));
      }
    }
    if (data.worker_status) {
      const oldWorker = this.workerStatus;
      this.workerStatus = data.worker_status as WorkerStatus;
      this.emit('state_change', {
        field: 'workerStatus',
        oldValue: oldWorker,
        newValue: this.workerStatus,
      });
      if (this.workerStatus === WorkerStatus.COMPLETE) {
        this._markComplete();
      } else if (this.workerStatus === WorkerStatus.ERROR || this.workerStatus === WorkerStatus.INTERRUPTED) {
        this._markError(new Error(`Process ended with worker status: ${this.workerStatus}`));
      }
    }
  }

  /**
   * Mark process as complete.
   * Closes all open groups and marks the flowDataStream as complete.
   * @internal
   */
  _markComplete(): void {
    if (!this._completed) {
      this._completed = true;
      // Close all open groups before marking complete
      this.flowDataStream.closeOpenGroups();
      this.flowDataStream.markComplete();
      this.emit('complete');
    }
  }

  /**
   * Mark process as failed.
   * @internal
   */
  _markError(error: Error): void {
    this._error = error;
    if (!this._completed) {
      this._completed = true;
      this.emit('error', error);
    }
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
