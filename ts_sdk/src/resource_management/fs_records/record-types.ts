/**
 * RecordType — the filesystem record types this client can encounter.
 *
 * Mirrors the Python RecordType. Members are kept only where a backend path
 * can actually emit them; a batch of `claude_settings:*`, `transcript_entry*`
 * and per-file Claude types was removed once it was clear nothing produced
 * them (one had even drifted: `claude_settings:mcp_server` here vs
 * `…:mcp_server_config` in Python, and nothing noticed).
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
  CLAUDE_HOOK = 'claude_hook',

  CLAUDE_DEBUG_LOG = 'claude_debug_log',
  CLAUDE_ERROR = 'claude_error',

  // ── Claude settings sub-record types ─────────────────
  CLAUDE_SETTINGS = 'claude_settings',

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
  /** FlowPad's own authored MCP asset — see the `Mcp` entity for the MCP_SERVER distinction. */
  MCP = 'mcp',
  MCP_SERVER = 'mcp_server',
  SUBAGENT = 'subagent',
  /** The launchable agent (agentic-assets/agent/<name>/agent.md).
   *  Distinct from SUBAGENT, the provider-owned .claude/agents/<name>.md. */
  AGENT = 'agent',
  COMMAND = 'command',
  CLAUDE_MD = 'claude_md',
  CLAUDE_MEMORY = 'claude_memory',
  CLAUDE_RULES = 'claude_rules',
  PROJECT = 'project',
  SESSION = 'session',
  PLAN = 'plan',
  PROMPT = 'prompt',
  DIRECTORY = 'directory',
  GITHUB_REPO = 'github_repo',
  TODO_FILE = 'todo_file',
  WHITEBOARD = 'whiteboard',
  DECK_TEMPLATE = 'deck_template',
  DECK = 'deck',
  SPREADSHEET = 'spreadsheet',
  AGENT_TRACE = 'agent_trace',
  DYNAMIC_WORKFLOW = 'dynamic_workflow',
  USAGE_REPORT = 'usage_report',
  ASSET_CLEANUP_REPORT = 'asset_cleanup_report',
  JOURNEY = 'journey',
  // A hub budget this box may spend. No file and no local row — the Assets
  // browser feeds it from the `llm-endpoint` box action (see
  // `flow_sdk/builtin/llm_endpoint.py`), and its editor is read-only.
  LLM_ENDPOINT = 'llm_endpoint',
}
