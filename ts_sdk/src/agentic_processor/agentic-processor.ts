import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';
import { ActionInfo } from '../models/ActionInfo';
import { TypeId } from '../models/TypeId';
import { FlowData } from '../flow_processing';
import { AgenticContext, serializeAgenticContext } from './agentic-context';
import { AgenticProcess, IAgenticProcess } from './agentic-process';
import { InstructionFile } from '../models/workflow/InstructionFile';

// Import shared types from agentic-types (breaks circular dependency)
import {
  ProcessorStatus,
  UIComponentPayload,
  ParsedUIUri,
  parseUIUri,
} from './agentic-types';

// Re-export so existing imports from './agentic-processor' continue to work
export { ProcessorStatus, parseUIUri };
export type { UIComponentPayload, ParsedUIUri };

/**
 * Interface for AgenticProcessor entity data
 */
export interface IAgenticProcessor extends IEntity {
  active_agentic_process_id?: string;
}

export interface CreateProcessOptions {
  /** Optional result metadata to create a ProcessResult child */
  result?: {
    uname?: string;
    resultType?: string;
    sourceSessionId?: string;
  };
  /** Whether to watch the processor before creating the process (default: true) */
  watchProcessor?: boolean;
  /** Whether to watch the created process immediately (default: true) */
  watchProcess?: boolean;
  /** Whether the process is visible in the tabs view (default: false) */
  visible?: boolean;
}

/**
 * AgenticProcessor Entity - Backend-synced processor for MDO instruction execution
 *
 * Extends APIEntity to receive entity notifications from the backend.
 * Uses dataManager for entity operations and receives FlowData via handleFlowData.
 *
 * Usage:
 * ```typescript
 * const computeNode = await ComputeNode.getLocal();
 * const processor = await computeNode.createAgenticProcessor();
 *
 * processor.on('ui', (payload) => {
 *   console.log('UI component:', payload);
 * });
 *
 * processor.on('waiting', (inputId) => {
 *   console.log('Waiting for input:', inputId);
 *   processor.sendInput({ answer: 'user response' });
 * });
 *
 * const process = await processor.run(instructionFile, context);
 * for await (const flowData of process.output()) {
 *   console.log('Output:', flowData);
 * }
 * ```
 */
@registerEntity
export class AgenticProcessor extends APIEntity<AgenticProcessor> implements IAgenticProcessor {
  /** Entity type for AgenticProcessor */
  static type: string = 'agentic_processor';

  /** Active agentic process ID if running */
  active_agentic_process_id?: string;

  /** Running processes map */
  private _runningProcesses: Map<string, AgenticProcess> = new Map();

  /** Collected FlowData */
  private _receivedFlowData: FlowData[] = [];

  constructor(entity: Partial<IAgenticProcessor> = {}) {
    // Backward compatibility: API tests still create "apu-{id}" TypeIds and
    // pass them into AgenticProcessor. Normalize legacy alias to this entity.
    const normalizedEntity = { ...(entity as any) };
    if (normalizedEntity.type === 'apu') {
      delete normalizedEntity.type;
    }

    super(normalizedEntity);
  }

  /**
   * Backward-compatible alias used by older APU tests.
   */
  get apuTypeId(): TypeId {
    return new TypeId('apu', this.id);
  }

  /**
   * Handle incoming FlowData from backend entity notification.
   * Overrides APIEntity.handleFlowData to also track FlowData
   * and emit typed events.
   */
  handleFlowData(flowData: FlowData): void {
    // Some backends emit duplicate FlowData for legacy processor/process wiring.
    // Ignore immediate duplicates so UI handlers stay deterministic in tests.
    const lastFlowData = this._receivedFlowData[this._receivedFlowData.length - 1];
    if (lastFlowData && this._isDuplicateFlowData(lastFlowData, flowData)) {
      return;
    }

    // Call parent to ingest to stream (with consolidation) and emit base event
    super.handleFlowData(flowData);

    this._receivedFlowData.push(flowData);

    // Do not forward FlowData to processes here.
    // The backend already emits flow_data to both processor and process entities,
    // and forwarding causes duplicate streaming in the process UI.

    // Check for completion marker - close ALL open groups
    if (flowData.attributes?.['complete'] === 'true') {
      this.flowDataStream.closeOpenGroups();
    }

    // Check for UI element
    const elementType = flowData.attributes?.['element-type'];
    if (elementType === 'ui') {
      const uiPayload = flowData.data as UIComponentPayload;
      this.emit('ui', uiPayload);
    }
  }

  /**
   * Called when entity data is updated via WebSocket notification.
   * Updates local state and emits events.
   */
  protected onEntityUpdate(_data: Partial<IAgenticProcessor>): void {
    // Status changes are pushed via AgenticProcess entity updates, not processor updates.
  }

  /**
   * Run instruction content or file with optional context.
   *
   * This is the unified interface for executing AMD instructions.
   * Returns an AgenticProcess that can be used to stream outputs and track state.
   *
   * @param input - InstructionFile, VFS path string, or raw MDO content string
   * @param contextOrOptions - AgenticContext (if input is InstructionFile) or options
   * @param options - Optional debug settings
   * @returns AgenticProcess for streaming outputs and state tracking
   *
   * @example
   * ```typescript
   * // With InstructionFile and context
   * const instructionFile = InstructionFile.fromContent(amdCode);
   * const context = { computeNode: await getLocalComputeNode() };
   * const process = await processor.run(instructionFile, context);
   *
   * // With VFS path
   * const process = await processor.run('/path/to/skill.md');
   *
   * // With raw content
   * const process = await processor.run('<!-- <flow-do> -->Say hello<!-- </flow-do> -->');
   *
   * for await (const flowData of process.output()) {
   *   console.log('Output:', flowData);
   * }
   * ```
   */
  public async run(
    input: InstructionFile | string,
    contextOrOptions?: AgenticContext | { sourceVfsPath?: string; debug?: boolean; breakpoints?: string[] },
    options?: { debug?: boolean; breakpoints?: string[] },
  ): Promise<AgenticProcess> {
    await this.watch();

    let actionName: string;
    let bodyParams: Record<string, unknown>;
    let context: AgenticContext | undefined;
    let instructionFile: InstructionFile | undefined;

    if (input instanceof InstructionFile) {
      context = contextOrOptions as AgenticContext;
      instructionFile = input;
      actionName = 'run';
      bodyParams = {
        instruction_content: input.content,
        context: context ? serializeAgenticContext(context) : {},
      };
    } else if (typeof input === 'string') {
      const entityTypePattern = /^[a-z_]+-[a-f0-9-]+\//i;
      const isVfsPath =
        input.startsWith('/') ||
        input.startsWith('vfs://') ||
        input.includes('/.flow/') ||
        entityTypePattern.test(input);

      if (isVfsPath) {
        actionName = 'runFile';
        bodyParams = { vfs_path: input };
      } else {
        actionName = 'run';
        bodyParams = { instruction_content: input };
      }
    } else {
      throw new Error('Invalid input: expected InstructionFile or string');
    }

    const actionInfo = new ActionInfo(actionName, AgenticProcessor.type, this.id, 'POST');
    actionInfo.bodyParameters = bodyParams;

    const response = await dataManager.callAction<unknown, IAgenticProcess>(actionInfo);
    const process = dataManager.updateEntityFromJson<AgenticProcess>(response);

    if (instructionFile) {
      process._instructionFile = instructionFile;
    }
    if (context) {
      process._context = context;
    }

    this._runningProcesses.set(process.id, process);
    await process.watch();

    process.on('complete', () => { this._runningProcesses.delete(process.id); });
    process.on('error', () => { this._runningProcesses.delete(process.id); });

    return process;
  }

  /**
   * @deprecated Use run() instead. Will be removed in future version.
   */
  public async start(
    mdoContent: string,
    options?: { sourceVfsPath?: string; debug?: boolean; breakpoints?: string[] },
  ): Promise<AgenticProcess> {
    return this.run(mdoContent, options);
  }

  /**
   * @deprecated Use run() instead. Will be removed in future version.
   */
  public async runFile(
    vfsPath: string,
    options?: { debug?: boolean; breakpoints?: string[] },
  ): Promise<AgenticProcess> {
    return this.run(vfsPath, options);
  }

  /**
   * Execute instruction content directly (simplified API).
   *
   * This is a simpler alternative to run() that takes instruction text
   * directly. Uses initialize_from_prompt() on the backend for single-instruction
   * execution.
   *
   * @param instructionContent - Plain text or AMD instruction content
   * @param context - AgenticContext with compute node and settings
   * @param options - Optional debug settings
   * @returns AgenticProcess for streaming outputs and state tracking
   *
   * @example
   * ```typescript
   * const computeNode = await ComputeNode.getLocal();
   * const processor = await computeNode.createAgenticProcessor();
   * const context = { workdir: '/path/to/project' };
   *
   * // Execute a simple instruction
   * const process = await processor.execute("List all Python files", context);
   * for await (const flowData of process.output()) {
   *   console.log('Output:', flowData);
   * }
   *
   * // Inject additional instructions during execution
   * await process.inject("Now count them");
   * ```
   */
  public async execute(
    instructionContent: string,
    context: AgenticContext,
    options?: { debug?: boolean; breakpoints?: string[] },
  ): Promise<AgenticProcess> {
    await this.watch();

    const actionInfo = new ActionInfo('execute', AgenticProcessor.type, this.id, 'POST');
    actionInfo.bodyParameters = {
      instruction_content: instructionContent,
      context: serializeAgenticContext(context),
      debug: options?.debug ?? false,
      breakpoints: options?.breakpoints ?? [],
    };

    // Backend creates process and returns entity data
    const response = await dataManager.callAction<unknown, IAgenticProcess>(actionInfo);

    // Reuse cached entity when available to avoid duplicate instances/listeners
    const process = dataManager.updateEntityFromJson<AgenticProcess>(response);

    // Store local references
    process._context = context;

    this._runningProcesses.set(process.id, process);

    // Watch the process entity for updates
    await process.watch();

    // Optimistically echo user message into the stream to avoid missing it before watch is active
    process.appendUserMessage(instructionContent);

    // Cleanup when process completes
    process.on('complete', () => {
      this._runningProcesses.delete(process.id);
    });

    process.on('error', () => {
      this._runningProcesses.delete(process.id);
    });

    return process;
  }

  /**
   * Create an idle process ready for execute() calls.
   *
   * This creates a process in IDLE status that can accept instructions
   * via process.executeInstruction(). The process stays alive until
   * explicitly terminated via process.exit().
   *
   * @param context - AgenticContext with compute node and settings
   * @returns AgenticProcess in IDLE status ready for instructions
   *
   * @example
   * ```typescript
   * const computeNode = await ComputeNode.getLocal();
   * const processor = await computeNode.createAgenticProcessor();
   * const process = await processor.createProcess(context);
   *
   * // Execute instructions on the process
   * await process.executeInstruction("Remember the number 42");
   * await process.executeInstruction("What's the number?");
   *
   * // Cleanup when done
   * await process.exit();
   * ```
   */
  public async createProcess(context: AgenticContext, options?: CreateProcessOptions): Promise<AgenticProcess> {
    if (options?.watchProcessor !== false) {
      await this.watch();
    }

    const actionInfo = new ActionInfo('createProcess', AgenticProcessor.type, this.id, 'POST');
    actionInfo.bodyParameters = {
      context: serializeAgenticContext(context),
      ...(options?.result
        ? {
            result: {
              uname: options.result.uname,
              resultType: options.result.resultType,
              sourceSessionId: options.result.sourceSessionId,
            },
          }
        : {}),
      ...(options?.visible !== undefined ? { visible: options.visible } : {}),
    };

    // Backend creates process and returns entity data
    const response = await dataManager.callAction<unknown, IAgenticProcess>(actionInfo);

    // Reuse cached entity when available to avoid duplicate instances/listeners
    const process = dataManager.updateEntityFromJson<AgenticProcess>(response);

    // Store local references
    process._context = context;

    this._runningProcesses.set(process.id, process);

    // Watch the process entity for updates
    if (options?.watchProcess !== false) {
      await process.watch();
    }

    return process;
  }

  /**
   * Get all running processes.
   */
  public getRunningProcesses(): Record<string, AgenticProcess> {
    const result: Record<string, AgenticProcess> = {};
    this._runningProcesses.forEach((process, id) => {
      result[id] = process;
    });
    return result;
  }

  /**
   * Get a specific running process by ID.
   */
  public getProcess(agenticProcessId: string): AgenticProcess | undefined {
    return this._runningProcesses.get(agenticProcessId);
  }

  /**
   * Get all received FlowData
   */
  public getReceivedFlowData(): readonly FlowData[] {
    return [...this._receivedFlowData];
  }

  /**
   * Cleanup and dispose processor
   */
  public dispose(): void {
    // Clear running processes
    for (const process of this._runningProcesses.values()) {
      process._markComplete();
    }
    this._runningProcesses.clear();
  }

  private _isDuplicateFlowData(a: FlowData, b: FlowData): boolean {
    const attrsA = a.attributes || {};
    const attrsB = b.attributes || {};

    return (
      attrsA['element-type'] === attrsB['element-type'] &&
      attrsA['ui-id'] === attrsB['ui-id'] &&
      attrsA['i'] === attrsB['i'] &&
      attrsA['t'] === attrsB['t']
    );
  }

}
