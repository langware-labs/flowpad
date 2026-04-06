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
import { ClaudeCliOptions } from '../cli_workers';
import { FlowDataFactory } from '../entities/flow/flow-data-factory';
import { Shell, ShellStatus } from '../entities/shell';
import { FlowData } from '../flow_processing';
import { FlowElementTypes } from '../flow_processing/flow-element-types';
import { ActionInfo } from '../models/ActionInfo';
import { DockPointerData } from '../models/DockPointer';
import { TypeId } from '../models/TypeId';
import { InstructionFile } from '../models/workflow/InstructionFile';
import { ViewType } from '../utils/ui/view-types';
import { VFSPath } from '../utils/vfs-path';
import { AgenticContext, IAgenticProcessOptions, ISpawnWorkerOptions, PermissionMode } from './agentic-context';
import { isProcessorRunning, ProcessorStatus } from './agentic-types';

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
 * Note: compute node is managed by backend Processor, not passed from frontend.
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
  status: ProcessorStatus;
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
  source_vfs_path?: string;
  workdir?: string | null;
  context?: Record<string, unknown>;
  context_data?: Record<string, unknown>;
  favorite_index?: number | null;
  status?: string;
  session_id?: string | null;
  use_worker_history?: boolean;
  /** Shell entity ID linked to this process */
  shell_id?: string | null;
  /** Whether this process is visible in the tabs view */
  visible?: boolean;
  /** Sidecar plain shell PTY session ID */
  sidecar_shell_id?: string | null;
  /** Backend TTL live field: true if a PTY session is actually alive (30s TTL) */
  is_active?: boolean;
  /** @internal — use AgenticProcess.cliOptions getter/setter instead */
  cli_config?: Record<string, any>;
  /** Extra directories passed to Claude via --add-dir */
  additional_dirs?: string[];
  /** Owning project ID */
  project_id?: string | null;
}

/**
 * AgenticProcess Entity - A running instruction execution process
 *
 * Created by AgenticProcessor.run(), this entity tracks execution state
 * and provides streaming access to FlowData outputs.
 *
 * @example
 * ```typescript
 * const process = await processor.run(instructionFile, context);
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
   * Replaces the manual `createProcess → open/watch` pattern.
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
          : { resume: true }
        : {}),
    });

    const process = await new AgenticProcess({
      cli_config: cliConfig.toJson(),
      context_data: {
        instructions: options.instructions,
        project_id: options.projectId,
        max_thinking_tokens: options.maxThinkingTokens ?? 1024,
        ...(options.resumeSessionId && !options.forkSession ? { resume_session_id: options.resumeSessionId } : {}),
      },
      workdir: options.workdir,
      visible: workerOptions?.visible,
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

  get searchDockPointer(): DockPointerData {
    if (this.session_id && this.project_encoded_name) {
      return new DockPointerData(ViewType.LENS, `claude/transcript/${this.project_encoded_name}/${this.session_id}`);
    }
    return this.dockPointer;
  }

  /** Instruction content being executed */
  instruction_content?: string;

  /** Source VFS path of the executed file */
  source_vfs_path?: string;

  /** Serialized execution context */
  context?: Record<string, unknown>;

  /** Persisted context data for session restoration */
  context_data?: Record<string, unknown>;

  /** Optional pinning index for tab ordering */
  favorite_index?: number | null;

  /** Current execution status — transcript-derived, updated via get_status action */
  status: ProcessorStatus;

  /** Worker session ID for resume capability */
  session_id?: string | null;

  /** Encoded project path for transcript navigation */
  project_encoded_name?: string | null;

  /** Whether worker manages its own history */
  use_worker_history?: boolean;

  /** Shell entity ID linked to this process */
  shell_id?: string | null;

  /** Whether this process is visible in the tabs view */
  visible?: boolean;

  /** Sidecar plain shell PTY session ID */
  sidecar_shell_id?: string | null;

  /** Owning project ID */
  project_id?: string | null;

  /** Backend TTL live field: true if a PTY session is actually alive (30s TTL) */
  is_active: boolean = false;

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

  /** Resolved execution status — ghost-running (any busy state + is_active=false) corrected to idle. */
  get resolvedStatus(): ProcessorStatus {
    const raw = this.status ?? ProcessorStatus.IDLE;
    if (isProcessorRunning(raw) && !this.is_active) {
      return ProcessorStatus.IDLE;
    }
    return raw;
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
    this.source_vfs_path = entity.source_vfs_path;
    this.context = entity.context;
    this.context_data = entity.context_data;
    this.favorite_index = entity.favorite_index;
    this.status = (entity.status as ProcessorStatus) ?? ProcessorStatus.IDLE;
    this.session_id = entity.session_id;
    this.use_worker_history = entity.use_worker_history;
    this.shell_id = entity.shell_id;
    this.visible = entity.visible;
    this.sidecar_shell_id = entity.sidecar_shell_id;
    this.is_active = entity.is_active ?? false;
  }

  /**
   * Get the instruction file (if set locally)
   */
  get instructionFile(): InstructionFile | undefined {
    return this._instructionFile;
  }

  /**
   * Get the workdir as a VFSPath if available.
   * Resolves machine paths using compute_node_id from context_data.
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

    const computeNodeId = this.context_data?.compute_node_id as string | undefined;
    if (!computeNodeId) {
      return VFSPath.parse(contextWorkdir);
    }

    try {
      const typeId = new TypeId(computeNodeId);
      return VFSPath.fromMachinePath(contextWorkdir, typeId);
    } catch {
      return VFSPath.parse(contextWorkdir);
    }
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
          // Mark as ready (historical items are complete)
          flowData.markReady();
          historyItems.push(flowData);
        }

        // Ingest history items to stream, skipping duplicates by elementType + role + content
        const existingKeys = new Set(
          this.flowDataStream.items.map((item) => {
            const role = item.attributes.role ?? '';
            return `${item.elementType}|${role}|${item.content ?? ''}`;
          }),
        );

        for (const item of historyItems) {
          const role = item.attributes.role ?? '';
          const key = `${item.elementType}|${role}|${item.content ?? ''}`;
          if (existingKeys.has(key)) {
            continue;
          }
          this.flowDataStream.ingest(item);
          existingKeys.add(key);
        }
        // Close any open groups after loading history
        this.flowDataStream.closeOpenGroups();

        // Check if process is already complete based on state
        if (this.status === ProcessorStatus.COMPLETE || this.status === ProcessorStatus.ERROR) {
          this._markComplete();
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
   * The process must be in IDLE status to accept new instructions.
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
  async executeInstruction(
    instruction: string,
    options: { sync?: boolean; workerSessionId?: string } = {},
  ): Promise<void> {
    const { sync = true, workerSessionId } = options;

    if (this.status === ProcessorStatus.INTERRUPTED) {
      throw new Error('Process has been terminated');
    }

    if (this.status === ProcessorStatus.RUNNING) {
      throw new Error('Process is already running');
    }

    // Remember the initial status
    const initialStatus = this.status;

    // Reset completion flag for new instruction (multi-turn support)
    this._completed = false;

    // Optimistically echo user message into the stream
    this.appendUserMessage(instruction);

    // Call backend execute action
    const actionInfo = new ActionInfo('execute', AgenticProcess.type, this.id, 'POST');
    actionInfo.bodyParameters = { instruction, ...(workerSessionId ? { worker_session_id: workerSessionId } : {}) };

    await dataManager.callAction(actionInfo);

    // If sync, wait for execution to complete
    if (sync) {
      // Wait for a state change (RUNNING -> IDLE cycle) to complete
      await this.waitForExecutionComplete(initialStatus);
    }
  }

  /**
   * Wait for execution to complete.
   * Listens for the 'complete' event which is emitted when status FlowData
   * with complete=true is received (following Flow's pattern of state via FlowData).
   */
  private async waitForExecutionComplete(_initialStatus: ProcessorStatus): Promise<void> {
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
   * Wait for process to return to IDLE status.
   *
   * Use this after async execute() calls to wait for completion.
   */
  async wait(): Promise<void> {
    if (this.status === ProcessorStatus.IDLE) {
      return;
    }

    return new Promise((resolve, reject) => {
      const checkState = () => {
        if (this.status === ProcessorStatus.IDLE) {
          unsubState();
          unsubError();
          resolve();
        } else if (this.status === ProcessorStatus.ERROR) {
          unsubState();
          unsubError();
          reject(new Error(this._error?.message || 'Process error'));
        } else if (this.status === ProcessorStatus.INTERRUPTED) {
          unsubState();
          unsubError();
          reject(new Error('Process was terminated'));
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
   * After exit, the process cannot accept new instructions.
   * The process is saved with status TERMINATED.
   *
   * @example
   * ```typescript
   * const process = await createProcess(context);
   * await process.execute("Do something");
   * await process.exit(); // Cleanup
   * ```
   */
  async exit(): Promise<void> {
    if (this.status === ProcessorStatus.INTERRUPTED) {
      return; // Already terminated
    }

    // Optimistically mark the shell CLOSING synchronously (no await) so the
    // loader's resolveDefaultShell sees it as non-alive and won't redirect back
    // to this tab while the exit API call is in-flight.
    if (this.shell_id) {
      const shell = Shell.getByIdFromCache(this.shell_id);
      if (shell) {
        shell.status = ShellStatus.CLOSING;
        dataManager.notifyEntityChanged(shell);
      }
    }

    const actionInfo = new ActionInfo('exit', AgenticProcess.type, this.id, 'POST');
    await dataManager.callAction(actionInfo);

    // Update local state
    this.status = ProcessorStatus.INTERRUPTED;
    this._markComplete();

    // Dispose the frontend PTY client. The backend already cleaned up the PTY
    // session as part of exit; shell.close() disposes _pty and handles the
    // expected 404 gracefully.
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
  async start(options?: { instruction?: string; visible?: boolean; ptyTimeout?: number }): Promise<boolean> {
    const { Shell } = await import('../entities/shell');
    const actionInfo = new ActionInfo('open', AgenticProcess.type, this.id, 'POST');
    actionInfo.bodyParameters = options ?? {};
    const result = await dataManager.callAction<
      unknown,
      { shell_id: string; session_id: string; shell: Record<string, unknown> } | null
    >(actionInfo);
    if (!result) throw new Error('Process could not be opened (process may be terminated)');
    this.shell_id = result.shell_id;
    this.session_id = result.session_id;
    dataManager.updateEntityFromJson(result.shell);
    const shell = await dataManager.getByTypeId<Shell>(new TypeId(Shell.type, result.shell_id));
    if (!shell) throw new Error(`Shell ${result.shell_id} not found after start()`);
    await shell.startPty({ cols: 80, rows: 24, timeout: options?.ptyTimeout });
    return true;
  }

  /**
   * Stop the current shell session.
   *
   * Delegates to Shell.close() for PTY teardown. The session_id is
   * preserved so the process can be resumed later via start().
   */
  async stop(): Promise<void> {
    const actionInfo = new ActionInfo('stop', AgenticProcess.type, this.id, 'POST');
    await dataManager.callAction(actionInfo);
    this.shell_id = null;
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
   * Send an instruction to Claude for execution.
   * Alias for executeInstruction() with sync=false.
   *
   * @param text - Instruction text
   */
  async prompt(text: string): Promise<void> {
    await this.executeInstruction(text, { sync: false });
  }

  /**
   * Write raw text to the live PTY stdin.
   * The shell must have an active PTY (call open() first).
   *
   * @param text - Text to send (newline appended automatically)
   */
  async sendInput(text: string): Promise<void> {
    if (!this.shell_id) throw new Error('[AgenticProcess.sendInput] No shell linked to this process');
    const { Shell } = await import('../entities/shell');
    const typeId = new TypeId(Shell.type, this.shell_id);
    const shell = await dataManager.getByTypeId<Shell>(typeId);
    if (!shell) throw new Error(`[AgenticProcess.sendInput] Shell ${this.shell_id} not found`);
    await shell.sendInput(text + '\n');
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
   * const process = await processor.run(instructionFile, context);
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
        this.status = statusData.status as ProcessorStatus;
        this.emit('state_change', { status: this.status });
      }
    }

    if (elementType === 'status' && isComplete) {
      this._markComplete();
    }
  }

  /**
   * Called by the store when the backend pushes an entity update via WebSocket.
   * Propagates state changes (including COMPLETE) so output() terminates correctly.
   * @internal
   */
  protected onEntityUpdate(data: Partial<IAgenticProcess>): void {
    if (data.status) {
      this.status = data.status as ProcessorStatus;
      this.emit('state_change', { status: this.status });
      if (this.status === ProcessorStatus.COMPLETE) {
        this._markComplete();
      }
      if (this.status === ProcessorStatus.ERROR) {
        this._markError(new Error(`Process ended with status: ${this.status}`));
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
