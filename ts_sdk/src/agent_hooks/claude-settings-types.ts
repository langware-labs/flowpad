/**
 * Claude Code settings.json type definitions.
 * These types represent the structure of hooks in Claude's settings files.
 */

/**
 * FlowPad metadata sub-object stored inside a hook entry.
 * Presence indicates the hook is FlowPad-managed.
 */
export interface FlowMetadata {
  /** Unique name within a settings file (e.g., "flowpad_sniffer", "my-hook") */
  name: string;
  /** ID used in the --hook-entry-id= CLI param */
  hook_entry_id?: string;
  /** AgentHook entity ID in the DB */
  flowpad_hook_id?: string;
}

/**
 * Individual hook entry within a matcher group.
 * Structure: { type: "command", command: "...", ...additionalProps }
 */
export interface ClaudeHookEntry {
  /** Hook type (usually "command") */
  type: string;
  /** Command to execute */
  command: string;
  /** FlowPad metadata (present = FlowPad-managed hook) */
  flow_metadata?: FlowMetadata;
  /** Additional properties */
  [key: string]: unknown;
}

/**
 * A matcher group containing one or more hook entries.
 * Structure: { matcher: "*", hooks: [...] }
 */
export interface ClaudeMatcherGroup {
  /** Matcher pattern (empty string or "*" for all) */
  matcher?: string;
  /** Array of hook entries */
  hooks: ClaudeHookEntry[];
}

/**
 * Hooks section in Claude settings.
 * Maps event types to arrays of matcher groups.
 */
export interface ClaudeHooksConfig {
  [eventType: string]: ClaudeMatcherGroup[];
}

/**
 * Full Claude settings.json structure (relevant fields).
 */
export interface ClaudeSettings {
  /** Hooks configuration by event type */
  hooks?: ClaudeHooksConfig;
  /** Other settings fields */
  [key: string]: unknown;
}

/**
 * Parameters for identifying a specific hook.
 */
export interface HookIdentifier {
  /** Event type (e.g., "UserPromptSubmit", "PreToolUse") */
  eventType: string;
  /** Matcher pattern */
  matcher: string;
  /** Command string */
  command: string;
}

/**
 * Result of a hook deletion operation.
 */
export interface HookOperationResult {
  /** Whether the deletion was successful */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** The deleted hook's event type */
  eventType?: string;
  /** The source file path */
  sourceFile?: string;
}
