/**
 * Centralized definition of all flow element types.
 * Aligned with backend FlowElementType enum in flow_data.py
 */

export const FlowElementTypes = {
  // Core message types
  UNKNOWN: 'unknown',
  USER_MESSAGE: 'user-message',
  PROMPT_ECHO: 'prompt-echo',
  CHAT: 'chat',
  TEXT: 'text',
  REASONING: 'reasoning',

  // Output types
  RESULT: 'result',
  SECRET: 'secret',
  SHELL_OUTPUT: 'shell-output',
  SHELL_INPUT: 'shell-input',
  SHELL: 'shell', // Legacy

  // State management
  MODE: 'mode', // DEPRECATED: Use STATE with key="current_mode" instead
  PHASE: 'phase', // DEPRECATED: Use STATE with key="flow_phase" instead
  STATUS: 'status',
  CHECKPOINT: 'checkpoint',
  GOAL: 'goal', // DEPRECATED: Use STATE with key="goal" instead
  STATE: 'state',

  // System types
  ERROR: 'error',
  DEBUG: 'debug',
  TRACE: 'trace',
  SOURCE: 'source',
  ENV_VAR: 'env-var',
  NOTIFICATION: 'notification',

  // Transport envelope: Python Entity.emit_entity_event(event, payload). Not
  // a renderable element — APIEntity.handleFlowData routes it to onEntityEvent.
  ENTITY_EVENT: 'entity_event',

  // File system
  WRITE: 'write',

  // Tool invocations (markers for tool pre/post hooks)
  TOOL_CALL: 'tool-call',
  TOOL_RESULT: 'tool-result',

  // UI control
  FOCUS: 'focus',

  // Special markers
  LLM_END: 'llm-end',
  END: 'end',
  CACHED_MESSAGE: 'cached-message',
  PROMPT_ANALYSIS: 'prompt_analysis',
  WEB_APP: 'web-app',
  SURVEY: 'survey',
  CONTINUE: 'continue',

  // Indexer / FAAS scan progress envelopes (emitted by in_process_activity)
  PROGRESS_REPORT: 'progress_report',

  // Execution tracing / webhooks
  WEBHOOK: 'webhook',

  // Claude Code hook events
  CLAUDE_HOOK: 'claude-hook',

  // UI control (agentic processor)
  UI: 'ui',

  // Agentic processor content types
  PLAN: 'plan',
  AMD: 'amd',
  MARKDOWN: 'markdown',

  // Test types (for unit tests only)
  TEST: 'test',
  TEST1: 'test1',
  TEST2: 'test2',
  TEST3: 'test3',
  TESTME: 'testme',
  CONFIG: 'config',
} as const;

export type FlowElementType = (typeof FlowElementTypes)[keyof typeof FlowElementTypes];

const TAG_PREFIX = 'flow-';

/**
 * Normalize element type by stripping 'flow-' prefix if present
 * @param value - Element type string (may or may not have 'flow-' prefix)
 * @returns Normalized element type without prefix
 */
export function normalizeElementType(value: string): string {
  const normalized = value.startsWith(TAG_PREFIX) ? value.substring(TAG_PREFIX.length) : value;

  // Warn if not found in FlowElementTypes enum
  if (!Object.values(FlowElementTypes).includes(normalized as FlowElementType)) {
    console.warn(`[normalizeElementType] Unknown element type: "${normalized}" (from: "${value}")`);
  }

  return normalized;
}

/**
 * Check if a string is a valid FlowElementType
 * Automatically normalizes the value by stripping 'flow-' prefix if present
 * @param value - Element type string to validate
 * @returns True if the value (after normalization) is a valid FlowElementType
 */
export function isFlowElementType(value: string): value is FlowElementType {
  const normalized = normalizeElementType(value);
  return Object.values(FlowElementTypes).includes(normalized as FlowElementType);
}

/**
 * Set of element types that support streaming consolidation.
 * These types can accumulate content without closing/reopening tags,
 * reducing bandwidth and parsing overhead by 30-50%.
 * Aligned with backend FlowElementType.streamable_types()
 */
export const STREAMABLE_ELEMENT_TYPES: Set<FlowElementType> = new Set([
  FlowElementTypes.REASONING,
  FlowElementTypes.CHAT,
  FlowElementTypes.SHELL_OUTPUT,
  FlowElementTypes.TRACE,
  FlowElementTypes.CACHED_MESSAGE,
]);

/**
 * Check if an element type supports streaming consolidation
 */
export function isStreamableElementType(elementType: string): boolean {
  return STREAMABLE_ELEMENT_TYPES.has(elementType as FlowElementType);
}
