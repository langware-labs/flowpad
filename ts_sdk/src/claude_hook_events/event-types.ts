/**
 * Hook event types and grouping constants for Claude Code hooks.
 */

/**
 * Types of hook events from Claude Code.
 * Based on Claude Code hooks documentation:
 * https://code.claude.com/docs/en/hooks
 */
export enum HookEventType {
  // Session lifecycle events
  SESSION_START = 'SessionStart',
  SESSION_END = 'SessionEnd',

  // User interaction events
  USER_PROMPT_SUBMIT = 'UserPromptSubmit',
  NOTIFICATION = 'Notification',

  // Tool events
  PRE_TOOL_USE = 'PreToolUse',
  POST_TOOL_USE = 'PostToolUse',
  POST_TOOL_USE_FAILURE = 'PostToolUseFailure',
  PERMISSION_REQUEST = 'PermissionRequest',

  // Agent stop/start events
  STOP = 'Stop',
  STOP_FAILURE = 'StopFailure',
  SUBAGENT_START = 'SubagentStart',
  SUBAGENT_STOP = 'SubagentStop',

  // Agent teams events
  TEAMMATE_IDLE = 'TeammateIdle',
  TASK_CREATED = 'TaskCreated',
  TASK_COMPLETED = 'TaskCompleted',

  // Configuration events
  CONFIG_CHANGE = 'ConfigChange',
  INSTRUCTIONS_LOADED = 'InstructionsLoaded',

  // Worktree events
  WORKTREE_CREATE = 'WorktreeCreate',
  WORKTREE_REMOVE = 'WorktreeRemove',

  // Compaction events
  PRE_COMPACT = 'PreCompact',
  POST_COMPACT = 'PostCompact',

  // MCP elicitation events
  ELICITATION = 'Elicitation',
  ELICITATION_RESULT = 'ElicitationResult',

  // File system events
  CWD_CHANGED = 'CwdChanged',
  FILE_CHANGED = 'FileChanged',
}

/**
 * Hook events that don't use matchers (always fire on every occurrence)
 */
export const HOOK_EVENTS_NO_MATCHER = [
  HookEventType.USER_PROMPT_SUBMIT,
  HookEventType.STOP,
  HookEventType.TEAMMATE_IDLE,
  HookEventType.TASK_COMPLETED,
  HookEventType.WORKTREE_CREATE,
  HookEventType.WORKTREE_REMOVE,
  HookEventType.CWD_CHANGED,
  HookEventType.FILE_CHANGED,
] as const;

/**
 * Hook events that use matchers
 */
export const HOOK_EVENTS_WITH_MATCHER = [
  HookEventType.PRE_TOOL_USE,
  HookEventType.POST_TOOL_USE,
  HookEventType.POST_TOOL_USE_FAILURE,
  HookEventType.PERMISSION_REQUEST,
  HookEventType.SESSION_START,
  HookEventType.SESSION_END,
  HookEventType.NOTIFICATION,
  HookEventType.SUBAGENT_START,
  HookEventType.SUBAGENT_STOP,
  HookEventType.STOP_FAILURE,
  HookEventType.PRE_COMPACT,
  HookEventType.POST_COMPACT,
  HookEventType.CONFIG_CHANGE,
  HookEventType.INSTRUCTIONS_LOADED,
  HookEventType.ELICITATION,
  HookEventType.ELICITATION_RESULT,
] as const;

/**
 * All available hook events
 */
export const ALL_HOOK_EVENTS = [...HOOK_EVENTS_NO_MATCHER, ...HOOK_EVENTS_WITH_MATCHER] as const;

/**
 * Default hooks to listen to — excludes worktree create event (which would replace the default behavior)
 */
export const DEFAULT_LISTENED_HOOKS = ALL_HOOK_EVENTS.filter(
  (e) => e !== HookEventType.WORKTREE_CREATE
);
