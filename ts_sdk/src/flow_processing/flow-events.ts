/**
 * Event type definitions for FlowStreamProcessor and FlowData
 * Simple const-based event names without complex type mappings
 */

/**
 * Data structure emitted with FlowDataEvents.CHUNK
 * Represents a chunk of streaming content for a FlowData element
 */
export interface FlowDataChunk {
  delta: string; // The new chunk just received
  totalContent: string; // All content accumulated so far
}

// FlowStreamProcessor Event Names
export const FlowEvents = {
  // Core events
  DATA: 'data', // Emitted when FlowData is ready
  DATA_START: 'data:start', // Emitted when FlowData element is starting
  DATA_END: 'data:end', // Emitted when FlowData element is complete
  LOG: 'log', // General logging
  LOG_VERBOSE: 'log:verbose', // Verbose logging
  ERROR: 'error', // Errors during processing
  DEBUG: 'debug', // Debug events

  // Aggregation events
  DATA_LIST: 'data:list',

  // Stream state events
  STREAM_START: 'stream:start', // Stream processing started
  STREAM_END: 'stream:end', // Stream processing ended
  STREAM_CANCEL: 'stream:cancel', // Stream was canceled
  STREAM_CANCEL_ERROR: 'stream:cancel:error', // Error during stream cancellation
  STREAM_RESUME: 'stream:resume', // Stream was resumed
  STREAM_ELEMENT_START: 'stream:element_start', // Element processing started
  STREAM_ELEMENT_END: 'stream:element_end', // Element processing completed

  // Execution events
  EXECUTION_STATUS: 'execution:status', // Execution status changed

  // Entity and artifact events
  ARTIFACT: 'artifact', // Artifact created
  ENTITY: 'entity', // Entity created/loaded

  // State events
  STATE_CHANGE: 'state-change', // Flow state changed

  // User action events
  USER_RUN: 'user:run', // User triggered run action
  USER_CANCEL: 'user:cancel', // User triggered cancel action
  USER_RESUME: 'user:resume', // User triggered resume action

  // UI events
  RENDER: 'render', // Force re-render of UI components
} as const;

// FlowData Event Names
export const FlowDataEvents = {
  // Data events
  CHUNK: 'chunk', // Content chunk received during streaming
  DATA: 'data',

  // State events
  PARSED: 'parsed', // Element data has been parsed
  READY: 'ready', // Element is fully processed and ready
  ERROR: 'error', // Element processing error

  // Logging events
  LOG: 'log', // General logging
  LOG_VERBOSE: 'log:verbose', // Verbose logging
} as const;

// Export all event values as arrays for runtime validation
export const FLOW_EVENT_NAMES = Object.values(FlowEvents);
export const FLOW_DATA_EVENT_NAMES = Object.values(FlowDataEvents);

// Helper function to check if an event name is valid
export function isValidFlowEvent(eventName: string): boolean {
  return FLOW_EVENT_NAMES.includes(eventName as any);
}

export function isValidFlowDataEvent(eventName: string): boolean {
  return FLOW_DATA_EVENT_NAMES.includes(eventName as any);
}
