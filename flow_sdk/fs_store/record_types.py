"""Record type constants used across the fs_store layer."""

from flow_sdk._compat import StrEnum


class RecordType(StrEnum):
    PROJECT = "project"
    CLAUDE_SESSION = "claude_session"
    TASK = "task"
    RULE = "rule"
    SKILL = "skill"
    AGENT = "agent"
    LOG = "log"
    AGENTIC_PROCESS = "agentic_process"
    ARTIFACT = "artifact"
    BOOKMARK = "bookmark"
    ANNOTATION = "annotation"
    COMMENT = "comment"

    # Claude Code record types
    CLAUDE_ROOT = "claude_root"
    ACCOUNT = "account"
    HOOK = "hook"
    HOOK_ENTRY = "hook_entry"
    CLAUDE_HOOK = "claude_hook"
    TODO_FILE = "todo_file"
    TODO_ITEM = "todo_item"
    PLAN = "plan"
    CLAUDE_MEMORY = "claude_memory"
    CLAUDE_RULES = "claude_rules"
    COMMAND = "command"
    MCP_SERVER = "mcp_server"
    PLUGIN = "plugin"
    CLAUDE_MD = "claude_md"
    HISTORY = "history"
    HISTORY_ENTRY = "history_entry"
    TRANSCRIPT_ENTRY = "transcript_entry"
    TRANSCRIPT_PROGRESS = "transcript_entry:progress"
    TRANSCRIPT_TOOL_USE = "transcript_entry:tool_use"
    TRANSCRIPT_TOOL_RESULT = "transcript_entry:tool_result"
    TRANSCRIPT_FILE_SNAPSHOT = "transcript_entry:file_snapshot"
    TRANSCRIPT_QUEUE_OPERATION = "transcript_entry:queue_operation"
    TRANSCRIPT_SUMMARY = "transcript_entry:summary"
    TRANSCRIPT_CUSTOM_TITLE = "transcript_entry:custom_title"
    TRANSCRIPT_PR_LINK = "transcript_entry:pr_link"
    COMPUTE_NODE = "compute_node"
    ENVIRONMENT = "environment"
    SESSION_ANALYSIS = "session_analysis"
    SESSION_CLASSIFICATION = "session_classification"
    ACTIVE_SESSIONS = "active_sessions"
    ACTIVE_SESSION = "active_session"
    SHELL = "shell"
    CLAUDE_DEBUG_LOG = "claude_debug_log"
    CLAUDE_ERROR = "claude_error"

    # Claude settings record types (from ~/.claude.json)
    CLAUDE_SETTINGS = "claude_settings"
    CLAUDE_SETTINGS_OAUTH = "claude_settings:oauth_account"
    CLAUDE_SETTINGS_PROJECT = "claude_settings:project_entry"
    CLAUDE_SETTINGS_MODEL_USAGE = "claude_settings:model_usage"
    CLAUDE_SETTINGS_MCP_SERVER = "claude_settings:mcp_server_config"
    CLAUDE_SETTINGS_FEATURE_FLAGS = "claude_settings:feature_flags"
    CLAUDE_SETTINGS_TIPS_HISTORY = "claude_settings:tips_history"
    CLAUDE_SETTINGS_SKILL_USAGE = "claude_settings:skill_usage"
    CLAUDE_SETTINGS_GITHUB_REPOS = "claude_settings:github_repos"

    # Claude settings.json record types
    CLAUDE_SETTINGS_JSON = "claude_settings_json"
    CLAUDE_SETTINGS_JSON_PERMISSIONS = "claude_settings_json:permissions"
    CLAUDE_SETTINGS_JSON_SANDBOX = "claude_settings_json:sandbox"
    CLAUDE_SETTINGS_JSON_ATTRIBUTION = "claude_settings_json:attribution"

    # Claude managed-settings.json record types
    CLAUDE_MANAGED_SETTINGS = "claude_managed_settings"

    # Claude .mcp.json record list type
    CLAUDE_MCP_JSON = "claude_mcp_json"

    # Claude API usage / rate limit record
    CLAUDE_USAGE = "claude_usage"

    # CLI log record types
    CLI_LOG = "cli_log"
    CLI_LOG_SETTINGS = "cli_log_settings"

    # Trigger log record types
    TRIGGER_LOG = "trigger_log"

    # Schema / operation log record types
    SCAN_LOG = "scan_log"
    INDEX_LOG = "index_log"

    # Search / index record types
    DOC_DB = "doc_db"

    # Error record types
    RECORD_ERROR = "record_error"

    # Generic file record types
    TEXT_FILE = "text_file"

    # Workflow record type
    WORKFLOW = "workflow"

    ASSET = "asset"
    DOCS = "docs"
    SPEC = "spec"
    CROSS_NOTIFICATION = "cross_notification"


class SkillitRecordType(StrEnum):
    SKILLIT_SESSION = "skillit_session"
    SKILLIT_CONFIG = "skillit_config"
