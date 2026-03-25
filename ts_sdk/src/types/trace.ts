/**
 * Trace types - manual mirror of backend types.
 *
 * Keep in sync with:
 * - flowpad/enums/trace_enums.py
 * - flowpad/shared/data_types.py
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

export interface TodoInfo {
  id: string;
  title: string;
  status: string;
  description?: string;
  keywords: string[];
  expected_artifacts: string[];
}

export interface PhaseTransitionData {
  from_phase: string;
  to_phase: string;
  current_todo?: TodoInfo;
}

export interface PromptAnalysisTraceData {
  goal: string;
  keywords: string[];
  labels: string[];
  expected_result_types: string[];
  confidence?: number;
}

export interface ToolExecutionData {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_output: Record<string, unknown>;
  duration_ms?: number;
  success: boolean;
}

export interface ErrorData {
  error_type: string;
  error_message: string;
  recoverable: boolean;
}

export interface TraceItem<T = unknown> {
  id: string;
  timestamp: string;
  type: TraceType;
  level: TraceLevel;
  message: string;
  summary?: string;
  data?: T;
}

// Type aliases for convenience
export type ChatTrace = TraceItem<null>;
export type PhaseTransitionTrace = TraceItem<PhaseTransitionData>;
export type PromptAnalysisTrace = TraceItem<PromptAnalysisTraceData>;
export type ToolExecutionTrace = TraceItem<ToolExecutionData>;
export type ErrorTrace = TraceItem<ErrorData>;

// Union of all trace data types
export type TraceData = PhaseTransitionData | PromptAnalysisTraceData | ToolExecutionData | ErrorData | null;
