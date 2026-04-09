/** Shared status and UI types for AgenticProcess. */

/**
 * Backend-owned process lifecycle status enum.
 *
 * This is Flowpad's control-plane FSM for an AgenticProcess resource.
 * It is not derived from Claude transcript output.
 */
export enum ProcessStatus {
  NEW = 'new',
  STARTING = 'starting',
  LIVE = 'live',
  STOPPING = 'stopping',
  STOPPED = 'stopped',
  FAILED = 'failed',
}

const ACTIVE_PROCESS_STATUSES = new Set<ProcessStatus>([
  ProcessStatus.STARTING,
  ProcessStatus.LIVE,
  ProcessStatus.STOPPING,
]);

const STARTABLE_PROCESS_STATUSES = new Set<ProcessStatus>([
  ProcessStatus.NEW,
  ProcessStatus.STOPPED,
  ProcessStatus.FAILED,
]);

export function isProcessActive(status: ProcessStatus): boolean {
  return ACTIVE_PROCESS_STATUSES.has(status);
}

export function isProcessStartable(status: ProcessStatus): boolean {
  return STARTABLE_PROCESS_STATUSES.has(status);
}

export function isProcessLive(status: ProcessStatus): boolean {
  return status === ProcessStatus.LIVE;
}

/**
 * Transcript-derived worker execution status.
 * Internal to the SDK — not part of the public API.
 * Use ProcessStatus (lifecycle) for external consumers.
 */
export enum ProcessorStatus {
  INIT         = 'init',
  EMPTY        = 'empty',
  IDLE         = 'idle',
  COMPLETE     = 'complete',
  ERROR        = 'error',
  INTERRUPTED  = 'interrupted',
  INACTIVE     = 'inactive',
  WAITING      = 'waiting',
  THINKING     = 'thinking',
  TOOL_CALL    = 'tool_call',
  TOOL_RUNNING = 'tool_running',
  RUNNING      = 'running',
  PAUSED       = 'paused',
  STEPPING     = 'stepping',
}

const RUNNING_STATUSES = new Set<ProcessorStatus>([
  ProcessorStatus.WAITING,
  ProcessorStatus.THINKING,
  ProcessorStatus.TOOL_CALL,
  ProcessorStatus.TOOL_RUNNING,
  ProcessorStatus.RUNNING,
  ProcessorStatus.PAUSED,
  ProcessorStatus.STEPPING,
]);

const TERMINAL_STATUSES = new Set<ProcessorStatus>([
  ProcessorStatus.COMPLETE,
  ProcessorStatus.ERROR,
  ProcessorStatus.INTERRUPTED,
  ProcessorStatus.INACTIVE,
]);

export function isProcessorRunning(status: ProcessorStatus): boolean {
  return RUNNING_STATUSES.has(status);
}

export function isProcessorTerminal(status: ProcessorStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * UI Component payload from flow-ui instruction
 */
export interface UIComponentPayload {
  ui_id: string;
  uri?: string;
  page?: string;
  params: Record<string, unknown>;
  schema?: Record<string, unknown>;
  blocking: boolean;
  content?: string;
}

/**
 * Parsed UI URI components
 */
export interface ParsedUIUri {
  /** Entity VFS path (e.g., "compute_node-@local/.flow/system_skills/onboarding") */
  entityVfs: string;
  /** Page name (e.g., "index") */
  page?: string;
  /** Component name (e.g., "hello-flowpad") */
  component?: string;
}

/**
 * Parse a UI URI into its components.
 *
 * URI format: ui://<entity_vfs>?page=<page>&component=<component>
 *
 * @param uri - The URI to parse (e.g., "ui://compute_node-@local/.flow/system_skills/onboarding?page=index&component=hello-flowpad")
 * @returns Parsed URI components
 */
export function parseUIUri(uri: string): ParsedUIUri {
  // Strip ui:// prefix
  const withoutProtocol = uri.replace(/^ui:\/\//, '');
  const [entityPart, queryPart] = withoutProtocol.split('?');

  const params = new URLSearchParams(queryPart || '');
  return {
    entityVfs: entityPart,
    page: params.get('page') || undefined,
    component: params.get('component') || undefined,
  };
}
