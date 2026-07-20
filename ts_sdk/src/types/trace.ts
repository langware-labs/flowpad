/**
 * Trace types - manual mirror of backend types.
 *
 * Keep in sync with:
 * - flowpad/enums/trace_enums.py
 * - flowpad/shared/trace_item.py
 */

// TraceType as const object for enum-like usage
export const TraceType = {
  CHAT: 'chat',
  PHASE_TRANSITION: 'phase_transition',
  PROMPT_ANALYSIS: 'prompt_analysis',
  TOOL_EXECUTION: 'tool_execution',
  ERROR: 'error',
  REASONING_STEP: 'reasoning_step',
  PERFORMANCE_METRICS: 'performance_metrics',
} as const;

export type TraceType = (typeof TraceType)[keyof typeof TraceType];

// TraceLevel as const object for enum-like usage
export const TraceLevel = {
  INFO: 'info',
  WARNING: 'warning',
  ERROR: 'error',
} as const;

export type TraceLevel = (typeof TraceLevel)[keyof typeof TraceLevel];

export interface TraceItem<T = unknown> {
  id: string;
  timestamp: string;
  type: TraceType;
  level: TraceLevel;
  message: string;
  summary?: string;
  data?: T;
}
