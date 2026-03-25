import { AxiosResponse } from 'axios';
import { APIEntity, dataManager, registerEntity } from '../../APIEntity';
import {
  FlowData,
  FlowDataFactory,
  FlowDataSource,
  FlowDataType,
  FlowElementTypes,
  FlowStreamProcessor,
} from '../../flow_processing';
import { FlowDataStream } from '../../flow_processing/flow-data-stream';
import { FlowError, FlowErrorUtils } from '../../flow_processing/flow-errors';
import { FlowDataChunk, FlowDataEvents, FlowEvents } from '../../flow_processing/flow-events';
import { decodeXMLEntities } from '../../flow_processing/xml-utilities';
import { ActionInfo } from '../../models';
// @ts-ignore
import { StateFlowData } from '../../flow_processing/flow-data-types/state-message';
import { ExpansionType } from '../../FlowSync/expand';
import { TypeId } from '../../models/TypeId';
import { fsStore } from '../../stores/fsStore';
import { Callable } from '../../types';
import { TraceItem } from '../../types/trace';
import { Artifact } from '../artifact/artifact';
import { CompletionOptions, ICompletionOptions } from './completion-options';
import { FlowMode, FlowPhase, FlowStateProperty, IChatOptions, IFlowState } from './flow-types';
// Re-export skill-labels utilities
export { isSkillLabel, labelToSkill, skillToLabel } from '../../utils/skill-labels';

export type ChatRole = 'user' | 'assistant' | 'machine' | 'system';

type FeedbackSentiment = 'positive' | 'neutral' | 'negative';

interface HistoryMessage {
  content: string;
  role: 'user' | 'assistant';
  timestamp: string;
}

export const FlowModeOptions = ['Ask', 'Agent', 'Auto'] as const;

export enum FlowExecutionStatus {
  Ready = 'Ready', // waiting for user inputs
  Running = 'Running', // Flow is running
  Canceled = 'Canceled', // Canceled was requested, Flow is not running
  Error = 'Error', // Not running, flow has error
}

export enum UserAction {
  Run = 'Run',
  Cancel = 'Cancel',
  Resume = 'Resume',
}

export const FlowEventTypes = {
  TEXT: 'text',
  REASONING: 'reasoning',
  SHELL: 'shell',
  RESULT: 'result',
  ENV_VAR: 'env-var',
  CHECKPOINT: 'checkpoint',
  DEBUG: 'debug',
} as const;

export type FlowEventType = (typeof FlowEventTypes)[keyof typeof FlowEventTypes];

/**
 * Data emitted with FlowEvents.USER_RUN event
 * Contains the user's message and chat options being sent to backend
 *
 * @example
 * ```typescript
 * flow.on(FlowEvents.USER_RUN, (data: UserRunEventData) => {
 *   console.log('User sent:', data.message);
 *   console.log('Chat options:', data.chatOptions);
 *   console.log('- Mode:', data.chatOptions.flowMode);
 *   console.log('- Labels:', data.chatOptions.labels);
 * });
 * ```
 */
export interface UserRunEventData {
  message: string;
  chatOptions: {
    flowMode?: FlowMode;
    labels?: string[];
    enableSearch?: boolean;
  };
}

interface UnifiedMessageBase {
  role: 'user' | 'assistant';
  timestamp: string;
}

// ChatMessageItem type union removed - using pure FlowData instead

export interface TraceMessageWrite extends UnifiedMessageBase {
  messageType: 'write';
  role: 'assistant';
  path: string;
  content: string;
}

export interface TraceMessageWebApp extends UnifiedMessageBase {
  messageType: 'web-app';
  role: 'assistant';
  webAppPort: number;
}

// Specialized trace log that extends TraceItem
export interface TraceMessageLog extends TraceItem {
  messageType: 'trace';
}

export type TraceSectionItem = TraceMessageWrite | TraceMessageWebApp | TraceMessageLog;

/**
 * Create default flow state with all fields initialized
 * Function to avoid circular import issues
 */
function createDefaultFlowState(): IFlowState {
  const defaultChatOptions: IChatOptions = {
    search: true,
    mode: {
      value: FlowMode.AGENT,
      model_choice: null,
    },
    labels: {
      value: [],
      model_choice: null,
    },
    auto_update_labels: {
      value: true,
      model_choice: null,
    },
  };

  return {
    message_history: [],
    trace_items: [],
    checkpoint_items: [],
    user_actions: [],
    run_usage: null,
    user_prompt_analysis: null,
    artifacts: [],
    chat_options: defaultChatOptions,
    breakpoint: null,
    flow_phase: FlowPhase.INITIAL,
    debug_paused_at: null,
  };
}

export interface ChatMessageFeedback {
  sentiment: FeedbackSentiment;
  feedback: string;
  thread_index: number;
  message_index: number;
}

export interface ChatMessage {
  role: ChatRole;
  raw_content: string;
  feedback?: ChatMessageFeedback;
}

@registerEntity
export class Flow extends APIEntity<Flow> {
  static type: string = 'flow';
  static autoLoadExpansions: ExpansionType[] = ['permissions'];
  title?: string;
  workspace_id?: string;
  agent_id?: string;
  project_id?: string;
  source_vfs_path?: string;
  current_compute_node_id?: string;
  current_terminal_id?: string;
  private _state: IFlowState | null = null;
  private _completionOptions: CompletionOptions | null = null;
  private _streamAbortController: AbortController | null = null;
  // Legacy _streamListeners removed - using pure FlowData events instead
  private _executionStatus: FlowExecutionStatus = FlowExecutionStatus.Ready;
  public statusCounters: Record<string, number> = {};
  public isResuming: boolean = false;
  private _sendMessageInProgress: boolean = false;

  // Stream management - main stream with history and message substreams
  private _stream: FlowDataStream = new FlowDataStream({ id: 'flow-main', name: 'Flow Main' });
  private _currentMessageStream: FlowDataStream | null = null;
  private _historyLoaded: boolean = false;
  private _historyLoading: Promise<void> | null = null;
  private _streamError: Error | null = null;
  private _streamProcessor: FlowStreamProcessor | null = null;
  // Legacy _parsedHistory removed - using pure FlowData stream instead
  // Note: _eventListeners is inherited from APIEntity
  private _errorLog: Error[] = [];
  // Public access to event listeners for debugging/introspection
  public get flow_events(): Map<string, Callable[]> {
    return this._eventListeners;
  }
  // Queue for CONTINUE messages to be processed after current message completes
  private _continueMessageQueue: Array<{ message: string; options?: ICompletionOptions }> = [];

  constructor(entity: Partial<Flow> = {}) {
    super(entity);
    this.title ||= '';
    this.initState();
  }

  /**
   * Initialize flow state with defaults (primarily for testing purposes)
   * Creates a new state object with default values
   */
  private initState(): void {
    this._state = createDefaultFlowState();

    // Create CompletionOptions after state is initialized
    this._completionOptions = new CompletionOptions(this._state);
  }
  /**
   * Get the history stream (child of main stream containing loaded history)
   */
  private get _history(): FlowDataStream {
    let historyStream = this._stream.getSubstream('history');
    if (!historyStream) {
      historyStream = new FlowDataStream({ id: 'history', name: 'History' });
      this._stream.addSubstream(historyStream);
    }
    return historyStream;
  }

  get executionStatus(): FlowExecutionStatus {
    return this._executionStatus;
  }

  get runningCounter(): number {
    return this.statusCounters[FlowExecutionStatus.Running] || 0;
  }

  set executionStatus(value: FlowExecutionStatus) {
    if (this._executionStatus !== value) {
      const previousValue = this._executionStatus;
      this._executionStatus = value;
      this.log('executionStatus', `${previousValue} -> ${value}`, '🔄');
      this.emit(FlowEvents.EXECUTION_STATUS, value);
      // Increment status counter for this state
      this.statusCounters[value] = (this.statusCounters[value] || 0) + 1;

      // Emit stream:end when execution completes (Running -> Ready)
      if (previousValue === FlowExecutionStatus.Running && value === FlowExecutionStatus.Ready) {
        this.emit(FlowEvents.STREAM_END);
        this.log('Flow ended (execution completed)', undefined, '✔');
      }
    }
  }

  // Backward compatibility and convenience getters
  get streamLoading(): boolean {
    return this.isRunning;
  }

  set streamLoading(value: boolean) {
    this.executionStatus = value ? FlowExecutionStatus.Running : FlowExecutionStatus.Ready;
  }

  get isRunning(): boolean {
    return this._executionStatus === FlowExecutionStatus.Running;
  }

  get isReady(): boolean {
    return this._executionStatus === FlowExecutionStatus.Ready;
  }

  get isCanceled(): boolean {
    return this._executionStatus === FlowExecutionStatus.Canceled;
  }

  get isError(): boolean {
    return this._executionStatus === FlowExecutionStatus.Error;
  }
  get streamError(): Error | null {
    return this._streamError;
  }

  get state(): IFlowState {
    return this._state!;
  }

  /**
   * Get CompletionOptions instance
   * This is the unified class for managing chat completion options
   */
  get options(): CompletionOptions {
    return this._completionOptions!;
  }

  get completionOptionsJson(): ICompletionOptions {
    return this._completionOptions!.toApiRequest(this.id);
  }

  /**
   * Get the processor elements (computed property from stream processor)
   */
  get processorElements(): FlowData[] {
    return this._streamProcessor ? this._streamProcessor.elements : [];
  }

  /**
   * Get all errors that have occurred during flow processing
   */
  get errorLog(): Error[] {
    return [...this._errorLog];
  }

  /**
   * Check if the flow has any errors
   */
  get hasErrors(): boolean {
    return this._errorLog.length > 0;
  }

  /**
   * Process XML content using FlowStreamProcessor and return FlowData array
   */
  ingestXmlChunk(content: string): FlowData[] {
    if (!this._streamProcessor) {
      this._streamProcessor = new FlowStreamProcessor();
      this.setupStreamProcessorEvents();
    }

    try {
      // Process content through stream processor
      // Source will be set to 'stream' when FlowData is received in setupStreamProcessorEvents
      this._streamProcessor.process_chunk(content);
      const events = this._streamProcessor.getAggregatedEvents();
      return events;
    } catch (error) {
      console.error('❌ Flow.processContent: Error processing XML content:', error);
      return [];
    }
  }

  /**
   * Process result data and attempt to create Artifact objects
   * Validates JSON structure and emits 'artifact' events
   */
  private processResultAsArtifact(resultData: FlowData): void {
    try {
      // Check if this is a result with artifact data
      const data = resultData.data;

      // Handle different data formats
      let artifactJson: any = null;

      if (typeof data === 'object' && data !== null) {
        // If data is already an object (from entity parsing)
        if (data.type === 'artifact') {
          artifactJson = data;
        } else if (data.content && typeof data.content === 'string') {
          // Try to parse content as JSON
          try {
            const parsed = JSON.parse(data.content);
            if (parsed.type === 'artifact') {
              artifactJson = parsed;
            }
          } catch {
            // Content is not JSON, ignore
          }
        }
      } else if (typeof data === 'string') {
        // Try to parse string data as JSON
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'artifact') {
            artifactJson = parsed;
          }
        } catch {
          // Not JSON, ignore
        }
      }

      // If we found artifact JSON, create Artifact instance
      if (artifactJson) {
        this.log('creating artifact from result', { name: artifactJson.name }, '📦');

        // Validate required artifact fields
        const errors: string[] = [];
        if (!artifactJson.name || artifactJson.name.trim() === '') {
          errors.push('name is required');
        }
        if (!artifactJson.path || artifactJson.path.trim() === '') {
          errors.push('path is required');
        }
        if (!artifactJson.ref_type) {
          errors.push('ref_type is required');
        }

        if (errors.length > 0) {
          throw new Error(`Invalid Artifact structure: ${errors.join(', ')}`);
        }

        // Create Artifact instance
        const artifact = new Artifact({
          id: artifactJson.id,
          name: artifactJson.name,
          ref_type: artifactJson.ref_type,
          path: artifactJson.path,
          description: artifactJson.description,
          metadata: artifactJson.metadata || {},
          project_id: artifactJson.project_id,
          generating_flow_id: this.id,
        });

        // Emit artifact event
        this.emit(FlowEvents.ARTIFACT, artifact);
        this.log('artifact created', { id: artifact.id, name: artifact.name }, '🎯');
      }
    } catch (error) {
      // Handle artifact creation errors
      this.log('artifact creation error', { error: error instanceof Error ? error.message : String(error) }, '❌');
      this._streamError = error instanceof Error ? error : new Error(String(error));
      const errorEvent = FlowErrorUtils.fromError(error, FlowError.ARTIFACT_CREATION_FAILED);
      this.emit(FlowEvents.ERROR, errorEvent);
    }
  }

  /**
   * Process entity data from JSON and emit entity/artifact events
   * Handles entity loading and error handling that was previously in FlowData
   */
  private processEntityData(entityData: FlowData): void {
    try {
      const data = entityData.data;
      if (!data || typeof data !== 'object') {
        console.error('Entity data is missing or invalid:', data);
        const errorEvent = FlowErrorUtils.createErrorEvent(
          FlowError.ENTITY_DATA_INVALID,
          'Entity data is missing or invalid',
          entityData,
        );
        this.emit(FlowEvents.ERROR, errorEvent);
        return;
      }

      // Validate entity has type field
      if (!data.type) {
        console.error('Entity missing type field:', data);
        const errorEvent = FlowErrorUtils.createErrorEvent(
          FlowError.ENTITY_MISSING_TYPE_FIELD,
          FlowError.ENTITY_MISSING_TYPE_FIELD,
          entityData,
        );
        this.emit(FlowEvents.ERROR, errorEvent);
        return;
      }

      try {
        // Load the entity using dataManager
        const entity = dataManager.updateEntityFromJson(data);

        // Update the FlowData with the loaded entity
        entityData.data = entity;

        this.log('entity loaded', { type: data.type, id: entity.id }, '🎯');

        // Emit general entity event
        this.emit(FlowEvents.ENTITY, entity);

        // Emit specific artifact event if this is an artifact
        if (data.type === 'artifact') {
          this.emit(FlowEvents.ARTIFACT, entity);
          this.log('artifact entity created', { id: entity.id, name: (entity as any).name || 'unknown' }, '🎯');
        }
      } catch (entityError: any) {
        console.error('Failed to load entity from FlowData:', entityError);
        // Check if it's an entity constructor not found error
        if (entityError.message?.includes('Entity constructor not found')) {
          const errorEvent = FlowErrorUtils.fromError(entityError, FlowError.ENTITY_CONSTRUCTOR_NOT_FOUND, entityData);
          this.emit(FlowEvents.ERROR, errorEvent);
        } else {
          const errorEvent = FlowErrorUtils.createErrorEvent(
            FlowError.ENTITY_LOAD_FAILED,
            `Failed to load entity: ${entityError}`,
            entityData,
            entityError instanceof Error ? entityError : undefined,
          );
          this.emit(FlowEvents.ERROR, errorEvent);
        }
        return;
      }
    } catch (error) {
      console.error('Failed to process entity data:', error);
      const errorEvent = FlowErrorUtils.fromError(error, FlowError.ENTITY_LOAD_FAILED, entityData);
      this.emit(FlowEvents.ERROR, errorEvent);
    }
  }

  /**
   * Process state updates from flow elements and emit state events
   * Handles both new flow-state elements (with key attribute) and legacy element types
   */
  private processStateUpdate(stateData: StateFlowData): void {
    try {
      // Update state directly
      if (!stateData.key) {
        console.warn('[Flow] state message missing key attribute', stateData.attributes);
        return;
      }
      if (!this._state) {
        console.error('[Flow] state is null, cannot update');
        return;
      }
      if (stateData.error) {
        console.error('[Flow] state update skipped, error', stateData.error_msg);
        return;
      }

      // Update state property
      this.setStateData(stateData.key, stateData.data);

      // Emit state change event
      this.log('state updated', { key: stateData.key }, '📊');
      this.emit(FlowEvents.STATE_CHANGE, {
        key: stateData.key,
        value: stateData.data,
      });
    } catch (error) {
      // Handle state update errors
      this.log('state update error', { error: error instanceof Error ? error.message : String(error) }, '❌');
      this._streamError = error instanceof Error ? error : new Error(String(error));
      const errorEvent = FlowErrorUtils.fromError(error, FlowError.STATE_UPDATE_FAILED);
      this.emit(FlowEvents.ERROR, errorEvent);
    }
  }

  /**
   * Update a flow state property and trigger any side effects
   */
  private setStateData(key: FlowStateProperty | keyof IFlowState, value: IFlowState[keyof IFlowState]): void {
    if (!this._state) {
      console.error('[Flow] state is null, cannot set state data');
      return;
    }

    switch (key) {
      case FlowStateProperty.CHAT_OPTIONS: {
        if (this._completionOptions && value) {
          this._completionOptions.setOptionsState(value as IChatOptions);
        }
        break;
      }
      default:
        (this._state as any)[key] = value;
        break;
    }
  }

  /**
   * Set up event listeners for the FlowStreamProcessor
   */
  private setupStreamProcessorEvents(): void {
    if (!this._streamProcessor) return;

    // Stream lifecycle events
    this._streamProcessor.on(FlowEvents.STREAM_START, () => {
      this.emit(FlowEvents.STREAM_START);
      this.log('Flow started', undefined, '🚀');
    });

    this._streamProcessor.on(FlowEvents.STREAM_END, () => {
      this.executionStatus = FlowExecutionStatus.Ready;
      this.isResuming = false;
      this._streamAbortController = null;
      this._sendMessageInProgress = false;
      this.emit(FlowEvents.STREAM_END);
      this.log('Flow ended successfully', undefined, '✔');
      this._processContinueMessageQueue();
    });

    this._streamProcessor.on(FlowEvents.STREAM_CANCEL, () => {
      this.executionStatus = FlowExecutionStatus.Ready;
      this.isResuming = false;
      this._streamAbortController = null;
      this._sendMessageInProgress = false;
      this.emit(FlowEvents.STREAM_CANCEL);
      this.log('Flow canceled', undefined, '❌');
    });

    // Main FlowData processing - delegate to processStreamFlowData
    this._streamProcessor.on(FlowEvents.DATA, (data: FlowData) => {
      this.processStreamFlowData(data);
    });

    this._streamProcessor.on(FlowEvents.DATA_START, (data: FlowData) => {
      this.handleFlowDataStart(data);
      this.emit(FlowEvents.DATA_START, data);
    });

    // FlowData completion processing - delegate to handleFlowDataEnd
    this._streamProcessor.on(FlowEvents.DATA_END, (data: FlowData) => {
      this.handleFlowDataEnd(data);

      // Handle PROMPT_ECHO during resume - mirror as user message
      if (this.isResuming && data.elementType === FlowElementTypes.PROMPT_ECHO) {
        // Defer user message creation to break out of synchronous call stack
        // This ensures React change detection works properly
        queueMicrotask(() => {
          if (!this._currentMessageStream) {
            console.error('[*DEBUG*] [Flow.PROMPT_ECHO] ❌ Cannot create user message - no active message stream');
            return;
          }

          // Create user message FlowData with the echo content
          // Add 1ms to timestamp to avoid duplication with PROMPT_ECHO
          const originalTimestamp = new Date(data.timestamp);
          const adjustedTimestamp = new Date(originalTimestamp.getTime() + 1);
          const userFlowData = FlowDataFactory.fromElementType(
            FlowElementTypes.USER_MESSAGE,
            data.content || '',
            {
              role: 'user',
              t: adjustedTimestamp.toISOString(),
              source: data.source, // Maintain same source
            },
            true,
          );

          // Ingest to stream (like sendMessage does)
          this._currentMessageStream.ingest(userFlowData);

          this.emit(FlowEvents.DATA, userFlowData);
        });
        // Reset isResuming flag after scheduling
        this.isResuming = false;
      }
    });

    // Handle streaming processor errors
    this._streamProcessor.on(FlowEvents.ERROR, (error: any) => {
      console.error('FlowStreamProcessor error:', error);

      // Add error to error log
      const errorObj = error instanceof Error ? error : new Error(error.message || String(error));
      this._errorLog.push(errorObj);

      const errorEvent = FlowErrorUtils.fromError(errorObj, FlowError.STREAM_PROCESSING_ERROR);
      this.emit(FlowEvents.ERROR, errorEvent);
      console.error('Flow message error:', error.partialElement);
    });
  }

  /**
   * Process FlowData during streaming (DATA event)
   * Processes each FlowData, sets up chunk listeners, and appends to streams
   */
  private processStreamFlowData(data: FlowData): void {
    // Call type-specific handler
    this.handleFlowDataByType(data);

    // Ingest to current message stream (enables consolidation)
    // Note: processStreamFlowData is only called during active streaming, so _currentMessageStream should always exist
    if (this._currentMessageStream) {
      this._currentMessageStream.ingest(data);
    } else {
      console.warn('processStreamFlowData called without active message stream - data not ingested', data);
    }

    // Emit DATA event for external listeners (e.g., tests)
    this.emit(FlowEvents.DATA, data);
  }

  /**
   * Handle FlowData by type during DATA event
   * Default: do nothing (most types don't need special handling)
   */
  private handleFlowDataByType(data: FlowData): void {
    switch (data.elementType) {
      case 'write':
        // FSStore integration: Set up chunk listeners for incremental updates
        // Only for live streams (history items don't fire chunk events)
        if (data.source !== FlowDataSource.History) {
          const path = data.attributes['path'];
          const mode = data.attributes['mode'];
          if (mode && mode === 'write') {
            fsStore.getState().setContent(path, '', true, this.projectTypeId);
          }
          if (path) {
            // Set up chunk event listener for incremental updates
            data.on(FlowDataEvents.CHUNK, ({ delta }: FlowDataChunk) => {
              // Append chunk to FSStore using the current project in dataContext (files belong to projects, not flows) - accumulates across multiple flow-write elements
              fsStore.getState().appendContent(path, delta, false, this.projectTypeId);
            });
          }
        }
        break;

      case 'result':
        // Result events are handled via ARTIFACT event
        break;

      case FlowElementTypes.CONTINUE: {
        // Queue CONTINUE messages to be processed after current message completes
        // Extract message from content (for string type) or data property
        const continueMessage =
          data.content ||
          (typeof data.data === 'string' ? data.data : '') ||
          (data.rawData && typeof data.rawData === 'string' ? data.rawData : '') ||
          'Continue';
        this._continueMessageQueue.push({ message: continueMessage });
        break;
      }

      default:
        // Do nothing for other types during DATA event
        // State updates are processed in handleFlowDataEndByType after parsing
        break;
    }
  }

  private handleFlowDataStart(_data: FlowData): void {
    // Call type-specific handler
  }
  /**
   * Handle FlowData completion (DATA_END event)
   * Processes final content and emits completion events
   */
  private handleFlowDataEnd(data: FlowData): void {
    // FSStore integration: Content is already accumulated via appendContent during streaming
    // No need to call setContent here - it would overwrite accumulated content with just this element's content
    if (data.elementType === FlowElementTypes.WRITE && this.typeId) {
      const path = data.attributes['path'];
      if (data.source === FlowDataSource.History) {
        console.log(
          `[Flow] 🚫 Skipping cache for history write:`,
          path,
          `source: ${data.source}, content length: ${data.content?.length || 0}`,
        );
      } else if (path && data.content) {
        // Content already accumulated via appendContent in chunk events
      }
    }
    const { path, rawDataContent } = this._currentMessageStream?.getPendingWriteContent() || {
      path: undefined,
      decodedRawDataContent: undefined,
    };
    if (path && rawDataContent) {
      const decodedRawDataContent = decodeXMLEntities(rawDataContent);
      fsStore.getState().setContent(path, decodedRawDataContent, true, this.projectTypeId);
    }
    // MAKE SURE TO HANDLE ALSO THE CASE OF STREAM ENDING WITH A FLOW-WRITE (LAST ITEM IS A FLOW-WRITE)
    // Call type-specific completion handler
    this.handleFlowDataEndByType(data);

    // Emit DATA_END event for external listeners
    this.emit(FlowEvents.DATA_END, data);
  }

  /**
   * Handle FlowData by type during DATA_END event
   * Default: do nothing (most types don't need special end handling)
   */
  private handleFlowDataEndByType(data: FlowData): void {
    // Handle result elements - create artifacts after content is fully parsed
    if (data.elementType === FlowElementTypes.RESULT) {
      this.processResultAsArtifact(data);
    }

    // Handle entity data type - process after content is fully parsed
    if (data.dataType === FlowDataType.Entity) {
      this.processEntityData(data);
    }

    // Process state updates after content is fully parsed
    if (data.elementType === FlowElementTypes.STATE) {
      this.processStateUpdate(data);
    }

    // Default: do nothing for other types
  }

  /**
   * Emit debug event with detailed flow status information
   */
  // private emitDebugEvent(
  //   event: string,
  //   phase: FlowDebugEvent['phase'],
  //   data: Partial<FlowDebugEvent['data']> = {},
  //   context?: string,
  // ): void {
  //   const debugEvent: FlowDebugEvent = {
  //     timestamp: new Date().toISOString(),
  //     event,
  //     processId: this.id,
  //     phase,
  //     data: {
  //       // Core flow state
  //       streamLoading: this.streamLoading,
  //       hasStreamProcessor: !!this._streamProcessor,
  //       elementCount: this._streamProcessor?.getAggregatedEvents().length || 0,
  //       messageCount: this.messages.length,

  //       // Context information
  //       context,

  //       // Merge additional data
  //       ...data,
  //     },
  //   };
  //   this.emit('debug', debugEvent);
  // }
  private getLogTypeIcon(tagName: string): string {
    switch (tagName) {
      case 'user-message':
        return '📩';
      case 'content':
        return '🅰';
      case 'reasoning':
        return '🧠';
      case 'text':
        return '🔤';
      case 'focus':
        return '🔍';
      case 'shell':
        return '💻';
      case 'result':
        return '🔍';
      case 'env-var':
        return '🔒';
      case 'checkpoint':
        return '🔄';
      case 'write':
        return '📝';
      case 'web-app':
        return '🌐';
      case 'trace':
        return '📊';
      default:
        return '🔷';
    }
  }
  /**
   * Centralized log method for all Flow log emissions
   * @param logType Short description (1-3 words) of the event
   * @param data Optional data object to include in the log
   * @param icon Icon to display in the log (default: 🔷)
   */
  public log(logType: string, data?: any, icon: string = '🔷'): void {
    const tagName = data?.elementType || '⚠️ unknown';
    const index = data?.index;
    const typeIcon = this.getLogTypeIcon(tagName);
    let logMessage: string = `${typeIcon} ${icon} [${tagName}](${index}) ${logType}`;

    if (data instanceof FlowData) {
      logMessage += ` -- ${data.toLog()}`;
      this.emit(FlowEvents.LOG, logMessage);
      return;
    }
    if (typeof data === 'string') {
      logMessage += ` -- ${data}`;
      this.emit(FlowEvents.LOG, logMessage);
      return;
    }
    if (data) {
      // Format data into a readable string
      const dataStr = Object.entries(data)
        .filter(([_, value]) => value !== undefined && value !== null)
        .map(([key, value]) => {
          if (typeof value === 'object') {
            return `${key}: ${JSON.stringify(value)}`;
          }
          if (typeof value === 'string') {
            return `${key}: ${value}`;
          }
          if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
            return `${key}: ${value.toString()}`;
          }
          if (typeof value === 'symbol') {
            return `${key}: ${value.toString()}`;
          }
          return `${key}: [unsupported type]`;
        })
        .join(', ');

      logMessage = `${icon} Flow(${this.id?.slice(0, 8) || 'new'}) ${logType}: ${dataStr}`;
    } else {
      logMessage = `${icon} Flow(${this.id?.slice(0, 8) || 'new'}) ${logType}`;
    }

    this.emit(FlowEvents.LOG, logMessage);
  }

  /**
   * Fetch flow state from the data store.
   * This method can be overridden in subclasses (e.g., FlowMock) to provide mock state for testing.
   *
   * In the normal flow, this fetches data using dataManager from the backend API.
   * In FlowMock, this returns the injected mock state.
   *
   * @returns Promise<IFlowState | null> - The flow state data
   */
  protected async fetchState(): Promise<IFlowState | null> {
    const actionInfo = new ActionInfo('state', this.getType(), this.id, 'GET');
    const response = await dataManager.callAction<IFlowState, AxiosResponse>(actionInfo);

    // Handle different response structures
    let stateData: IFlowState | null = null;
    if (response?.data?.data) {
      stateData = response.data.data;
    } else if (response?.data) {
      stateData = response.data;
    } else if (response && typeof response === 'object' && 'flow_phase' in response) {
      // The API is returning the flow state data directly as the response
      stateData = response as unknown as IFlowState;
    }
    return stateData;
  }

  async loadFlowState(): Promise<IFlowState | null> {
    if (!this.saved) {
      return null;
    }

    try {
      const stateData = await this.fetchState();

      // Set the full state (which will emit events)
      this.setState(stateData);

      // Notify CompletionOptions of chat_options state (apply full values on initial load)
      if (stateData?.chat_options) {
        this._completionOptions?.setOptionsState(stateData.chat_options, true);
      }

      return this.stateJson;
    } catch (error) {
      console.error('Error loading flow state:', error);
      return null;
    }
  }

  get stateJson(): IFlowState | null {
    return this._state;
  }

  /**
   * Set flow state (primarily for testing purposes)
   * Emits a state event to notify subscribers
   */
  setState(state: IFlowState | null): void {
    if (!state) {
      return;
    }
    // Emit state change event for each key
    const keys = Object.keys(state);
    keys.forEach((key) => {
      this.setStateData(key as FlowStateProperty, state[key as keyof IFlowState]);
      this.emit(FlowEvents.STATE_CHANGE, {
        key,
        value: state[key as keyof IFlowState],
      });
    });
  }

  async sendFeedbackToServer(feedback: ChatMessageFeedback): Promise<boolean> {
    if (!feedback) {
      return false;
    }
    const actionInfo = new ActionInfo('feedback', this.getType(), this.id, 'POST');
    actionInfo.bodyParameters = {
      feedback: feedback,
    };
    const response = await dataManager.callAction<ChatMessageFeedback, AxiosResponse>(actionInfo);
    return response && response.status == 200 && response.data.status === 'SUCCESS';
  }

  get projectTypeId(): TypeId | undefined {
    return this.expand?.auth_scopes?.flat().find((scope) => scope.type === 'project');
  }

  get history(): FlowData[] {
    return [...this._history.items];
  }

  /**
   * Process XML content to FlowData array with unified timestamp injection and source setting.
   * Used by both history loading and potentially future sources.
   *
   * @param xmlContent - The XML string to parse
   * @param baseTimestamp - Base timestamp for synthetic timestamp generation
   * @param source - Source of the FlowData (stream, history, etc.)
   * @returns Array of parsed FlowData objects
   */
  private processXMLToFlowData(xmlContent: string, baseTimestamp: string, source: FlowDataSource): FlowData[] {
    const baseTime = new Date(baseTimestamp);
    const baseMicroseconds = baseTime.getTime();
    let index = 0;
    let hasMissingTimestamps = false;

    // Inject timestamps into XML before parsing (but NOT source - we set that directly on FlowData)
    const processedXML = xmlContent.replace(/<([a-z-]+)(\s[^>]*)?>/gi, (match, tagName, attrs) => {
      // Check if already has 't' attribute
      const hasTimestamp = attrs && /\st=["']/.test(attrs);

      if (!hasTimestamp) {
        hasMissingTimestamps = true;
        // Create unique timestamp by adding millisecond offsets
        const offsetTime = new Date(baseMicroseconds + index);
        const timestamp = offsetTime.toISOString();
        index++;

        // Inject only timestamp attribute
        const newAttrs = attrs || '';
        return `<${tagName}${newAttrs} t="${timestamp}">`;
      }

      return match;
    });

    // Warn if we had to inject timestamps (one warning per message)
    if (hasMissingTimestamps) {
      console.warn(
        `[FlowData] Message at ${baseTimestamp} missing element timestamps, injected ${index} synthetic timestamp(s) from ${source}`,
      );
    }

    // Create a temporary processor to parse the XML
    const processor = new FlowStreamProcessor();

    // Process the entire XML content with injected timestamps
    processor.process_chunk(processedXML);

    // Get all parsed FlowData objects and set source directly
    const flowDataArray = processor.getAggregatedEvents();
    flowDataArray.forEach((fd) => (fd.source = source));

    return flowDataArray;
  }

  /**
   * Validate and correct history timestamps to ensure monotonic ordering.
   * If a timestamp violation is detected (item N <= item N-1), the timestamp
   * is corrected to previous timestamp + 1ms and the error is logged.
   *
   * This ensures the history stream maintains chronological consistency
   * even if backend data has timestamp irregularities.
   *
   * @param historyItems - Array of FlowData items from history (modified in place)
   */
  private validateAndCorrectHistoryTimestamps(historyItems: FlowData[]): void {
    if (historyItems.length === 0) return;

    const CORRECTION_OFFSET_MS = 10; // 1ms increment for corrections
    let _correctionCount = 0;

    for (let i = 1; i < historyItems.length; i++) {
      const prevItem = historyItems[i - 1];
      const currItem = historyItems[i];

      const prevTime = new Date(prevItem.timestamp).getTime();
      const currTime = new Date(currItem.timestamp).getTime();

      // Check for violation: current timestamp must be strictly greater than previous
      if (currTime <= prevTime) {
        _correctionCount++;

        // Correct by setting current timestamp to previous + 1ms
        const correctedTime = new Date(prevTime + CORRECTION_OFFSET_MS);

        // Modify the timestamp directly (before stream assignment)
        (currItem as any).timestamp = correctedTime.toISOString();
      }
    }

    // Log summary if any corrections were made
    if (_correctionCount > 0) {
      console.warn(
        `[Flow.History] ✅ Timestamp corrected for ${_correctionCount} ${_correctionCount === 1 ? 'entry' : 'entries'}`,
      );
    }
  }

  /**
   * Fetch history messages from the data store.
   * This method can be overridden in subclasses (e.g., FlowMock) to provide mock history for testing.
   *
   * In the normal flow, this fetches data using dataManager from the backend API.
   * In FlowMock, this returns the injected mock history.
   *
   * @returns Promise<HistoryMessage[]> - Array of history messages
   */
  protected async fetchHistory(): Promise<HistoryMessage[]> {
    const actionInfo = new ActionInfo('history', Flow.type, this.id, 'GET');
    const messages = await dataManager.callAction<void, HistoryMessage[]>(actionInfo);
    return messages;
  }

  protected async handleLoad(): Promise<void> {
    //this._stream.clear();
    await Promise.all([this.loadFlowState(), this.loadHistory(), this.resume()]);
  }

  async loadHistory(): Promise<void> {
    // If already loaded or no ID, return immediately
    if (this._historyLoaded || !this.id) return;

    // If already loading, return the existing promise to avoid duplicate requests
    if (this._historyLoading) {
      return this._historyLoading;
    } // Create and store the loading promise to prevent race conditions
    this._historyLoading = (async () => {
      try {
        const messages = await this.fetchHistory();
        const historyFlowData: FlowData[] = [];

        for (const msg of messages) {
          if (msg.role === 'user') {
            // User messages stay simple - no XML parsing needed
            historyFlowData.push(
              FlowDataFactory.fromElementType(
                FlowElementTypes.USER_MESSAGE,
                msg.content,
                {
                  role: msg.role,
                  t: msg.timestamp,
                  source: FlowDataSource.History,
                },
                true,
              ),
            );
          } else {
            // Assistant messages contain XML that needs to be parsed into individual FlowData objects
            // Use unified XML processing with timestamp injection and source setting
            const parsedEvents = this.processXMLToFlowData(msg.content, msg.timestamp, FlowDataSource.History);

            // Add all parsed FlowData objects to history
            historyFlowData.push(...parsedEvents);
          }
        }
        // Validate and enforce monotonic time ordering before appending to stream
        this.validateAndCorrectHistoryTimestamps(historyFlowData);

        historyFlowData.forEach((item) => {
          item.parseElementData();
          this._history.ingest(item);
        });
        // Close any open groups after loading history
        this._history.closeOpenGroups();

        this._historyLoaded = true;
      } catch (error) {
        console.error(`[Flow.loadHistory][${new Date().toISOString()}] ❌ Failed to load flow history:`, error);
      } finally {
        // Clear the loading promise once complete (success or failure)
        this._historyLoading = null;
      }
    })();

    return this._historyLoading;
  }

  get stream(): FlowDataStream {
    return this._stream;
  }

  get items(): FlowData[] {
    return [...this._stream.items];
  }

  /**
   * Override handleFlowData to also append to the main stream and emit DATA event.
   * This ensures WebSocket FlowData (like instruction trace reports) appears in TraceSection.
   */
  handleFlowData(flowData: FlowData): void {
    // Call parent to handle flowDataStream and emit 'flow_data' event
    super.handleFlowData(flowData);
    // Also ingest to main stream so TraceSection can see it (enables consolidation)
    this._stream.ingest(flowData);
    // Emit FlowEvents.DATA so TraceSection's listener triggers
    this.emit(FlowEvents.DATA, flowData);
  }

  static async cancel(processId: string) {
    const flow = dataManager.getByTypeIdFromCache<Flow>(new TypeId(Flow.type, processId));
    if (!flow) {
      throw new Error('Flow not found');
    }
    return await flow.cancel();
  }

  /**
   * API call for cancel - makes the cancel request
   */
  protected async callCancelAPI(): Promise<void> {
    const actionInfo = new ActionInfo('cancel-completion', Flow.type, this.id, 'POST');
    await dataManager.callAction(actionInfo);
  }

  /**
   * Process cancel result - handles cleanup and events
   */
  protected processCancelResult(): void {
    // Only emit cancel event after successful API response
    this.executionStatus = FlowExecutionStatus.Canceled;
    this._streamError = null;
    this._streamProcessor?.reset();
    this._streamProcessor = null;
    // this.emitStreamData(); // Legacy removed
    this.emit(FlowEvents.STREAM_CANCEL);
    this.log('cancel', undefined, '🧑');
  }

  async cancel() {
    // Emit user action event immediately regardless of state/success
    this.emit(FlowEvents.USER_CANCEL);

    try {
      this._streamAbortController?.abort();
      this._streamAbortController = null;

      await this.callCancelAPI();
      this.processCancelResult();
    } catch (error) {
      // Emit error if cancel API call fails
      const cancelError = error instanceof Error ? error : new Error(String(error));
      this.emit(FlowEvents.STREAM_CANCEL_ERROR, cancelError);
      this.log('cancel error', undefined, '🧑⚠️');
      throw error;
    }
  }

  clear(): void {
    this._streamAbortController?.abort();
    this._streamAbortController = null;
    this.executionStatus = FlowExecutionStatus.Ready;
    this._streamError = null;
    this._errorLog = [];
    this._streamProcessor?.reset();
    this._streamProcessor = null;
    // Clear all streams
    this._stream.clear();
    this._currentMessageStream = null;
    this._historyLoaded = false;
    this._historyLoading = null;
  }

  async _handleStreamResponse(response: Response, abortController: AbortController) {
    if (!response.body) {
      throw new Error('Completion Response body is null - server may not support streaming');
    }
    const reader = response.body.getReader();
    if (!this._streamProcessor) {
      this._streamProcessor = new FlowStreamProcessor();
      this.setupStreamProcessorEvents();
    }
    await this._streamProcessor.ingestStream(reader, abortController);
  }

  /**
   * API call for resume - returns Response that can be processed
   */
  protected async callResumeAPI(): Promise<{ response: Response; abortController: AbortController } | null> {
    const abortController = new AbortController();
    const actionInfo = new ActionInfo(
      'resume-completion',
      Flow.type,
      this.id,
      'POST',
      false,
      true,
      abortController.signal,
    );
    try {
      const response = await dataManager.callAction<undefined, Response | null>(actionInfo);

      if (!response) {
        return null; // No response from API
      }

      if (response.status === 204) {
        this.log('resume error', 'no flow to resume', '🚫');
        return null; // No flow to resume
      }

      return { response, abortController };
    } catch (error) {
      console.error('[Flow.callResumeAPI] ❌ Resume error for flow:', this.id, error);
      return null;
    }
  }

  /**
   * Initialize stream state for a new message or resume operation
   * Creates a new FlowDataStream and resets the processor
   */
  private initializeStreamForNewMessage(streamId: string): FlowDataStream {
    // Initialize without setting streamLoading - wait for successful response
    this._streamError = null;

    // Create message stream
    this._currentMessageStream = new FlowDataStream(streamId);
    this._stream.addSubstream(this._currentMessageStream);

    // Reset processor for new stream (history persists)
    this._streamProcessor?.reset();
    this._streamProcessor = null;

    return this._currentMessageStream;
  }

  /**
   * Handle stream operation errors with consistent error state and event emission
   */
  private handleStreamError(error: unknown, operation: string): never {
    console.error(`Flow.${operation}: Error occurred`, error);
    // Set error state and emit standardized error
    this._streamError = error instanceof Error ? error : new Error(String(error));
    this.executionStatus = FlowExecutionStatus.Error;
    this.log(`${operation} error`, this._streamError, '🔴');

    // Emit standardized error event
    const errorEvent = FlowErrorUtils.fromError(error, FlowError.STREAM_PROCESSING_ERROR);
    this.emit(FlowEvents.ERROR, errorEvent);

    throw error;
  }

  /**
   * Process resume result - handles the response stream and events
   */
  protected async processResumeResult(response: Response, abortController: AbortController): Promise<void> {
    // Set streaming state after successful response
    this._streamAbortController = abortController;
    this.executionStatus = FlowExecutionStatus.Running;
    // this.emitStreamData(); // Legacy removed
    this.emit(FlowEvents.STREAM_RESUME);
    await this._handleStreamResponse(response, abortController);
  }

  async resume() {
    // Don't resume if there's already an active stream (e.g., from sendMessage)
    // This prevents duplicate streams and duplicate user messages
    if (
      this._sendMessageInProgress ||
      this._streamAbortController ||
      this.executionStatus === FlowExecutionStatus.Running
    ) {
      return;
    }

    // Emit user action event immediately regardless of state/success
    this.emit(FlowEvents.USER_RESUME);
    this.log('resume requested', undefined, '🧑');

    try {
      const result = await this.callResumeAPI();
      if (result) {
        // Initialize stream for resumed conversation
        this.isResuming = true;
        this.executionStatus = FlowExecutionStatus.Running;
        const timestamp = new Date().toISOString();
        this.initializeStreamForNewMessage(`resume-${timestamp}`);
        await this.processResumeResult(result.response, result.abortController);
      }
    } catch (error) {
      this.handleStreamError(error, 'resume');
    }
  }

  /**
   * API call for sendMessage - returns Response that can be processed
   */
  protected async callSendMessageAPI(
    message: string,
    options?: ICompletionOptions,
  ): Promise<{ response: Response; abortController: AbortController }> {
    const abortController = new AbortController();
    const actionInfo = new ActionInfo('completion', Flow.type, this.id, 'POST', false, true, abortController.signal);
    actionInfo.bodyParameters = {
      message: message,
      labels: options?.labels,
      ...options,
    };

    const response = await dataManager.callAction<{ message: string }, Response>(actionInfo);

    return { response, abortController };
  }

  /**
   * Process sendMessage result - handles the response stream and events
   */
  protected async processSendMessageResult(response: Response, abortController: AbortController): Promise<void> {
    // Set streaming state after successful response
    this.executionStatus = FlowExecutionStatus.Running;
    // this.emitStreamData(); // Legacy removed

    this._streamAbortController = abortController;
    await this._handleStreamResponse(response, abortController);
  }

  async sendMessage(message: string, options?: ICompletionOptions) {
    // Mark sendMessage as in progress to prevent resume() from running
    this._sendMessageInProgress = true;
    try {
      // Merge completionOptions getter with provided options, prioritizing parameter values
      const mergedOptions: ICompletionOptions = options
        ? { ...this.completionOptionsJson, ...options }
        : this.completionOptionsJson;

      // Emit user action event immediately with prompt and chat options
      this.emit(FlowEvents.USER_RUN, {
        message,
        chatOptions: mergedOptions,
      });
      this.log('request', undefined, '🧑');

      // Initialize stream with first 30 chars of message as ID
      const messagePrefix = message.substring(0, 30).replace(/\s+/g, '-');
      const messageStream = this.initializeStreamForNewMessage(`message-${messagePrefix}`);

      // Create and append user message to current message stream BEFORE API call (optimistic UI)
      const timestamp = new Date().toISOString();
      const userFlowData = FlowDataFactory.fromElementType(
        FlowElementTypes.USER_MESSAGE,
        message,
        {
          role: 'user',
          t: timestamp, // Use 't' for timestamp attribute
          source: FlowDataSource.Stream, // User input is part of streaming conversation
        },
        true,
      );
      messageStream.ingest(userFlowData);

      const { response, abortController } = await this.callSendMessageAPI(message, mergedOptions);

      await this.processSendMessageResult(response, abortController);
    } catch (error) {
      this.handleStreamError(error, 'sendMessage');
    } finally {
      // Reset flag when stream ends (handled in stream end handlers)
      // But also reset here in case of early error
      if (!this._streamAbortController) {
        this._sendMessageInProgress = false;
      }
    }
  }

  /**
   * Process queued CONTINUE messages after current message completes
   * Recursively calls sendMessage until queue is empty
   */
  private _processContinueMessageQueue(): void {
    if (this._continueMessageQueue.length === 0) {
      return;
    }

    // Pop the first message from the queue
    const queuedMessage = this._continueMessageQueue.shift();
    if (!queuedMessage) {
      return;
    }

    // Recursively call sendMessage with the queued message
    // This will trigger a new stream, and when it ends, _processContinueMessageQueue will be called again
    void this.sendMessage(queuedMessage.message, queuedMessage.options);
  }

  // Event handling methods - on, off, emit are inherited from APIEntity

  /**
   * Remove all listeners for a specific event type
   */
  removeAllListeners(eventType?: string): void {
    if (eventType) {
      this._eventListeners.delete(eventType);
    } else {
      this._eventListeners.clear();
    }
  }

  /**
   * Get list of all event types currently being listened to
   */
  getEventTypes(): string[] {
    return Array.from(this._eventListeners.keys());
  }

  /**
   * Get count of listeners for a specific event type
   */
  getListenerCount(eventType: string): number {
    return this._eventListeners.get(eventType)?.length || 0;
  }

  /**
   * Check if there are any listeners for a specific event type
   */
  hasListeners(eventType: string): boolean {
    return this.getListenerCount(eventType) > 0;
  }

  /**
   * Enable logging by listening to log events and outputting them to console
   */
  enable_log(): void {
    this.on(FlowEvents.LOG, (logMessage: string) => {
      console.log(logMessage);
    });
  }

  static async noteItemUpdated(itemName: string, processId: string) {
    const actionInfo = new ActionInfo('note-item-updated', Flow.type, processId, 'POST');
    actionInfo.bodyParameters = { item_name: itemName };
    await dataManager.callAction(actionInfo);
  }

  /**
   * Build the host URL for accessing a port on this flow's compute node.
   * Returns the action URL that will redirect to the actual host.
   *
   * @param port - The port number to access
   * @returns The action URL for the get-host endpoint
   */
  getHostUrl(port: number): string {
    const actionInfo = new ActionInfo('get-host', Flow.type, this.id, 'GET');
    actionInfo.queryParameters = { port: port.toString() };
    return actionInfo.fullActionUrl;
  }
}
