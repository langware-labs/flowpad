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
 *
 * Phase 9: canonical conversational payload now lives on `process_entry`
 * (typed). Variant-specific fields that used to be flat top-level optionals
 * now live under `extra`. Legacy field declarations are kept so existing UI
 * consumers (event-utils, event-summaries) compile; runtime values come
 * through `extra` and may be undefined on the top-level declarations until
 * consumers migrate.
 */
export interface HookEventData {
  hook_event_name: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  permission_mode?: string;

  // Phase 9 — typed conversational payload + raw spillover from the wire.
  process_entry?: {
    transcript_entry: Record<string, unknown>;
    observation_kind: 'live' | 'hook_pre' | 'hook_post' | 'replay' | 'synthesized';
    received_at: string;
  };
  extra?: Record<string, unknown>;

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
