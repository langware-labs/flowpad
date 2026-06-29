/**
 * RecordType — exhaustive string enum of every filesystem record type.
 * Mirrors the Python RecordType and includes all `claude_settings:*` variants.
 */
export enum RecordType {
  // ── Core resource types ──────────────────────────────
  ANNOTATION = 'annotation',
  MARKDOWN = 'markdown',
  TASK = 'task',
  SKILL = 'skill',
  LOG = 'log',
  RULE = 'rule',
  AGENTIC_PROCESS = 'agentic_process',

  // ── Claude Code record types ─────────────────────────
  CLAUDE_SESSION = 'claude_session',
  CLAUDE_ROOT = 'claude_root',
  CLAUDE_HOOK = 'claude_hook',
  CLAUDE_HOOK_ENTRY = 'claude_hook_entry',
  CLAUDE_MCP_SERVER = 'claude_mcp_server',
  CLAUDE_COMMAND = 'claude_command',
  CLAUDE_HISTORY = 'claude_history',
  CLAUDE_HISTORY_ENTRY = 'claude_history_entry',
  CLAUDE_ACTIVE_SESSIONS = 'claude_active_sessions',
  CLAUDE_ACTIVE_SESSION = 'claude_active_session',
  CLAUDE_ACCOUNT = 'claude_account',

  CLAUDE_DEBUG_LOG = 'claude_debug_log',
  CLAUDE_ERROR = 'claude_error',

  // ── Claude transcript entry types ─────────────────────
  TRANSCRIPT_ENTRY = 'transcript_entry',
  TRANSCRIPT_PROGRESS = 'transcript_entry:progress',
  TRANSCRIPT_TOOL_USE = 'transcript_entry:tool_use',
  TRANSCRIPT_TOOL_RESULT = 'transcript_entry:tool_result',
  TRANSCRIPT_FILE_SNAPSHOT = 'transcript_entry:file_snapshot',
  TRANSCRIPT_QUEUE_OPERATION = 'transcript_entry:queue_operation',
  TRANSCRIPT_SUMMARY = 'transcript_entry:summary',
  TRANSCRIPT_CUSTOM_TITLE = 'transcript_entry:custom_title',
  TRANSCRIPT_PR_LINK = 'transcript_entry:pr_link',

  // ── Claude settings sub-record types ─────────────────
  CLAUDE_SETTINGS = 'claude_settings',
  CLAUDE_SETTINGS_BASE = 'claude_settings:base',
  CLAUDE_SETTINGS_OAUTH_ACCOUNT = 'claude_settings:oauth_account',
  CLAUDE_SETTINGS_PROJECT_ENTRY = 'claude_settings:project_entry',
  CLAUDE_SETTINGS_MODEL_USAGE = 'claude_settings:model_usage',
  CLAUDE_SETTINGS_MCP_SERVER = 'claude_settings:mcp_server',
  CLAUDE_SETTINGS_FEATURE_FLAGS = 'claude_settings:feature_flags',
  CLAUDE_SETTINGS_TIPS_HISTORY = 'claude_settings:tips_history',
  CLAUDE_SETTINGS_SKILL_USAGE = 'claude_settings:skill_usage',
  CLAUDE_SETTINGS_GITHUB_REPOS = 'claude_settings:github_repos',

  // ── Claude settings.json record types ────────────────
  CLAUDE_SETTINGS_JSON = 'claude_settings_json',
  CLAUDE_SETTINGS_JSON_PERMISSIONS = 'claude_settings_json:permissions',
  CLAUDE_SETTINGS_JSON_SANDBOX = 'claude_settings_json:sandbox',
  CLAUDE_SETTINGS_JSON_ATTRIBUTION = 'claude_settings_json:attribution',

  // ── Claude managed-settings.json ───────────────────
  CLAUDE_MANAGED_SETTINGS = 'claude_managed_settings',

  // ── Claude .mcp.json ──────────────────────────────
  CLAUDE_MCP_JSON = 'claude_mcp_json',

  // ── System profile types ─────────────────────────────
  PLUGIN = 'plugin',
  MARKETPLACE = 'marketplace',
  HOOK = 'hook',
  MCP_SERVER = 'mcp_server',
  AGENT = 'agent',
  COMMAND = 'command',
  CLAUDE_MD = 'claude_md',
  CLAUDE_MEMORY = 'claude_memory',
  CLAUDE_RULES = 'claude_rules',
  PROJECT = 'project',
  SESSION = 'session',
  PLAN = 'plan',
  PROMPT = 'prompt',
  WORKFLOW = 'workflow',
  DIRECTORY = 'directory',
  GITHUB_REPO = 'github_repo',
  TODO_FILE = 'todo_file',
  WHITEBOARD = 'whiteboard',
  AGENT_TRACE = 'agent_trace',
  DYNAMIC_WORKFLOW = 'dynamic_workflow',
  USAGE_REPORT = 'usage_report',
}
