import { Resolvable } from '../../types/resolvable';

export interface FlowCheckpointItem {
  message: string;
  timestamp: Date;
}

export enum FlowPhase {
  INITIAL = 'initial',
  PLANNING = 'planning',
  EXECUTING = 'executing',
  REPORTING = 'reporting',
  COMPLETED = 'completed',
  ERROR = 'error',
}

export enum FlowMode {
  ASK = 'Ask',
  AGENT = 'Agent',
  AUTO = 'Auto',
  UNKNOWN = 'Unknown',
}

/**
 * Simple flat interface for chat options values
 * Used by controlled components (value/onChange pattern)
 */
export interface IChatOptionsValues {
  search: boolean;
  mode: FlowMode;
  labels: string[];
  autoUpdateLabels: boolean;
}

/**
 * Pure JSON interface for chat options (serializable)
 * Represents the chat options state as it comes from/goes to the backend
 */
export interface IChatOptions {
  search: boolean;
  mode: {
    value: FlowMode;
    model_choice: FlowMode | null;
  };
  labels: {
    value: string[];
    model_choice: string[] | null;
  };
  auto_update_labels: {
    value: boolean;
    model_choice: boolean | null;
  };
}

/**
 * Chat options state with resolvable mode and labels.
 * @deprecated Use IChatOptions for JSON representation
 */
export interface ChatOptionsState {
  search: boolean;
  mode: Resolvable<FlowMode>;
  labels: Resolvable<string[]>;
  auto_update_labels: Resolvable<boolean>;
}

export interface IFlowState {
  message_history: any[];

  trace_items: any[];
  checkpoint_items: FlowCheckpointItem[];
  user_actions: string[];

  run_usage: any;

  user_prompt_analysis: any;

  artifacts: any[];
  chat_options: IChatOptions;
  breakpoint: FlowPhase | null;
  flow_phase: FlowPhase | string;
  debug_paused_at: FlowPhase | null;
}

export enum FlowStateProperty {
  MESSAGE_HISTORY = 'message_history',
  TRACE_ITEMS = 'trace_items',
  CHECKPOINT_ITEMS = 'checkpoint_items',
  USER_ACTIONS = 'user_actions',
  RUN_USAGE = 'run_usage',
  USER_PROMPT_ANALYSIS = 'user_prompt_analysis',
  ARTIFACTS = 'artifacts',
  CHAT_OPTIONS = 'chat_options',
  BREAKPOINT = 'breakpoint',
  FLOW_PHASE = 'flow_phase',
  DEBUG_PAUSED_AT = 'debug_paused_at',
}
