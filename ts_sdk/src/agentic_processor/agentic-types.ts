/**
 * Shared types for AgenticProcessor and AgenticProcess.
 *
 * Extracted to break circular dependency:
 *   agentic-process -> agentic-processor -> agentic-process
 *
 * Both modules now import these types from agentic-types instead.
 */

/**
 * Processor execution status enum
 */
export enum ProcessorStatus {
  IDLE = 'idle',
  RUNNING = 'running',
  PAUSED = 'paused',
  STEPPING = 'stepping',
  COMPLETE = 'complete',
  ERROR = 'error',
  TERMINATED = 'terminated',
}

/**
 * Stack frame for nested execution contexts
 */
export interface StackFrame {
  frameId: string;
  type: 'call' | 'block' | 'if' | 'each';
  instructionId: string;
  index: number;
  sourceVfsPath?: string;
  localVariables: Record<string, unknown>;
  iteratorName?: string;
  iteratorIndex?: number;
  iteratorTotal?: number;
}

/**
 * Debug state
 */
export interface DebugState {
  enabled: boolean;
  breakpoints: string[];
  stepMode: 'over' | 'into' | 'out' | null;
}

/**
 * Processor state - synced from backend entity
 */
export interface ProcessorState {
  status: ProcessorStatus;
  index: number;
  totalInstructions: number;
  currentInstructionId: string | null;
  variables: Record<string, unknown>;
  waitingForInput: boolean;
  inputId: string | null;
  stack: StackFrame[];
  debug: DebugState;
  error: string | null;
  mdoContent: string | null;
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
