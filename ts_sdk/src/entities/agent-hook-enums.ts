/**
 * Enums and types for agent hooks system
 */

// Re-export canonical hook event types and data from shared SDK module
export {
  HookEventType,
  HOOK_EVENTS_NO_MATCHER,
  HOOK_EVENTS_WITH_MATCHER,
  ALL_HOOK_EVENTS,
  DEFAULT_LISTENED_HOOKS,
} from '../claude_hook_events/event-types';
export type { HookEventData, UsageInfo } from '../claude_hook_events/hook-event-data';

/**
 * Configuration scope for agent hooks
 */
export enum HookScope {
  USER = 'user', // ~/.claude/settings.json (or equivalent)
  PROJECT = 'project', // .claude/settings.json (or equivalent)
  LOCAL = 'local', // .claude/settings.local.json (or equivalent)
}

/**
 * SubAgent provider types
 */
export enum AgentProvider {
  CLAUDE_CODE = 'claude_code',
  // Future: CURSOR = 'cursor', etc.
}

/**
 * Types of actions that can be triggered
 */
export enum TriggerActionType {
  NOP = 'nop',
  NOTIFY_ENTITY = 'notify_entity',
}

/**
 * Sub-actions for relationship operations
 */
export enum RelationshipSubAction {
  ADD = 'add',
  REMOVE = 'remove',
}

/**
 * Action to be executed when a trigger matches
 */
export interface TriggerAction {
  action_type: TriggerActionType;
}
