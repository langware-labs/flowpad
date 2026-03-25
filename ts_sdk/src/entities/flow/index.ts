/**
 * Flow module barrel export
 * Consolidates all flow-related exports
 */

// Flow entity class - kept for backward compatibility (many UI files still import it)
export { Flow, FlowExecutionStatus, UserAction } from './flow';
export type {
  ChatMessageFeedback,
  ChatRole,
  TraceSectionItem,
  TraceMessageWrite,
  TraceMessageWebApp,
  TraceMessageLog,
} from './flow';

// Export flow types (interfaces, enums, types only)
export { FlowMode, FlowPhase, FlowStateProperty } from './flow-types';
export type {
  ChatOptionsState,
  FlowCheckpointItem,
  IChatOptions,
  IChatOptionsValues,
  IFlowState as IFlowState,
} from './flow-types';

export { CompletionMessageType, CompletionOptions, CompletionOptionsEvents } from './completion-options';
export type { CompletionOptionsChangeEvent, ICompletionOptions } from './completion-options';

// Re-export skill-labels utilities for convenience
export { isSkillLabel, labelToSkill, skillToLabel } from '../../utils/skill-labels';
