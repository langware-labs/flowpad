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
  PROJECT = 'project', // <repo>/.claude/settings.json — committed to git
  LOCAL = 'local', // <repo>/.claude/settings.local.json — gitignored
  PROCESS = 'process', // per-AgenticProcess, handed over at launch
}

/**
 * Mirrors the Python `HookScope`. The first three are *global* — a persisted
 * file the harness discovers on its own, so the hook fires for every run of
 * that harness, including runs Flowpad never launched. `PROCESS` is *local*:
 * argv the launcher supplies, so it exists only for a process Flowpad spawned.
 *
 * `LOCAL` is the pre-existing spelling of what Python calls `LOCAL_PROJECT`;
 * same wire value, so settings written before the rename keep resolving.
 */
export const GLOBAL_HOOK_SCOPES = [HookScope.USER, HookScope.PROJECT, HookScope.LOCAL] as const;

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
