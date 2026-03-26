/**
 * Provider-agnostic model for hook event data.
 * Fields match the JSON input schema from Claude Code hooks.
 */

/** Token usage information. */
export interface UsageInfo {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Provider-agnostic model for hook event data.
 * Covers all Claude Code hook event types.
 */
export interface HookEventData {
  hook_event_name: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  permission_mode?: string;

  // Tool events (PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest)
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: Record<string, unknown>;
  tool_use_id?: string;
  error?: string;
  is_interrupt?: boolean;
  permission_suggestions?: Array<Record<string, unknown>>;

  // UserPromptSubmit
  prompt?: string;

  // Notification
  message?: string;
  title?: string;
  notification_type?: string;

  // SessionStart
  source?: string;
  model?: string;
  agent_type?: string;

  // SessionEnd
  reason?: string;

  // SubagentStart / SubagentStop
  agent_id?: string;
  agent_transcript_path?: string;
  last_assistant_message?: string;
  stop_hook_active?: boolean;

  // TeammateIdle / TaskCreated / TaskCompleted
  teammate_name?: string;
  team_name?: string;
  task_id?: string;
  task_subject?: string;
  task_description?: string;

  // ConfigChange
  file_path?: string;

  // WorktreeCreate
  name?: string;

  // WorktreeRemove
  worktree_path?: string;

  // PreCompact
  trigger?: string;
  custom_instructions?: string;

  // Legacy
  output?: string;
  usage?: Record<string, number>;
}
