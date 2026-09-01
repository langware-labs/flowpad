"""The single canonical type enum for FlowPad.

`EntityType` is the one source of truth for every record/entity type name. It
replaces the two historical enums — `RecordType` (fs_store) and
`BuiltinEntityType` (db) — which are now thin aliases re-exported from their old
modules for backward compatibility during the migration.

String VALUES are persisted in the DB and on the filesystem (`record.type`,
`TypeId.type`), so they must never change. Member names are the union of the two
old enums (17 names overlapped with identical values; no value divergences).
"""

from flow_sdk._compat import StrEnum


class EntityType(StrEnum):
    # ── FS-indexed / Claude record types (formerly RecordType) ───────────────
    PROJECT = "project"
    CLAUDE_SESSION = "claude_session"
    TASK = "task"
    RULE = "rule"
    SKILL = "skill"
    # A Claude Code *subagent* definition — a `.claude/agents/<name>.md` prompt
    # asset. Named for what the provider calls it. The FAMILY stays "agents"
    # because the directory is provider-owned.
    SUBAGENT = "subagent"
    # The launchable agent: identity (name/avatar/system prompt) + the launch
    # bundle, deployed via a Deployment and run as an AgenticProcess. Distinct
    # from SUBAGENT, which is the provider's `.claude/agents/*.md` prompt asset
    # this may delegate to.
    AGENT = "agent"
    LOG = "log"
    AGENTIC_PROCESS = "agentic_process"
    ARTIFACT = "artifact"
    DEPLOYMENT = "deployment"
    BOOKMARK = "bookmark"
    ANNOTATION = "annotation"
    COMMENT = "comment"
    APP_SECRET = "app_secret"
    CLAUDE_ROOT = "claude_root"
    ACCOUNT = "account"
    HOOK = "hook"
    HOOK_ENTRY = "hook_entry"
    CLAUDE_HOOK = "claude_hook"
    # Scaffold type — settings.json-shaped files that contain hook definitions.
    CLAUDE_HOOK_SOURCE = "claude_hook_source"
    TODO_FILE = "todo_file"
    TODO_ITEM = "todo_item"
    PLAN = "plan"
    CLAUDE_MEMORY = "claude_memory"
    CLAUDE_RULES = "claude_rules"
    COMMAND = "command"
    # FlowPad's OWN MCP asset (authored, v4, attachable). Distinct from
    # MCP_SERVER below, which is the read-only scan of a vendor's config files.
    MCP = "mcp"
    MCP_SERVER = "mcp_server"
    # Scaffold type — .mcp.json / mcp.json files that contain server definitions.
    MCP_SERVER_SOURCE = "mcp_server_source"
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
    CLAUDE_SETTINGS = "claude_settings"
    CLAUDE_SETTINGS_OAUTH = "claude_settings:oauth_account"
    CLAUDE_SETTINGS_PROJECT = "claude_settings:project_entry"
    CLAUDE_SETTINGS_MODEL_USAGE = "claude_settings:model_usage"
    CLAUDE_SETTINGS_MCP_SERVER = "claude_settings:mcp_server_config"
    CLAUDE_SETTINGS_FEATURE_FLAGS = "claude_settings:feature_flags"
    CLAUDE_SETTINGS_TIPS_HISTORY = "claude_settings:tips_history"
    CLAUDE_SETTINGS_SKILL_USAGE = "claude_settings:skill_usage"
    CLAUDE_SETTINGS_GITHUB_REPOS = "claude_settings:github_repos"
    CLAUDE_SETTINGS_JSON = "claude_settings_json"
    CLAUDE_SETTINGS_JSON_PERMISSIONS = "claude_settings_json:permissions"
    CLAUDE_SETTINGS_JSON_SANDBOX = "claude_settings_json:sandbox"
    CLAUDE_SETTINGS_JSON_ATTRIBUTION = "claude_settings_json:attribution"
    CLAUDE_MANAGED_SETTINGS = "claude_managed_settings"
    CLAUDE_MCP_JSON = "claude_mcp_json"
    # Per-server fragment of a ``.mcp.json`` file, emitted by the source-file
    # extractor (fs_store/source_file_records.py) for the /fs-records/file
    # settings API. Follows the ``claude_settings_json:permissions`` fragment
    # convention: the *file* shape is Claude-specific, while the server entity
    # itself is the agent-neutral MCP_SERVER asset above. (The extractor
    # previously referenced a non-existent CLAUDE_MCP_SERVER member and raised
    # AttributeError on any .mcp.json with servers.)
    CLAUDE_MCP_JSON_ENTRY = "claude_mcp_json:entry"
    CODEX_SESSION = "codex_session"
    # DEPRECATED 2026-05-09: codex projects now stored as PROJECT with a
    # codex_project=True provenance flag. Kept for backward compatibility.
    CODEX_PROJECT = "codex_project"
    COPILOT_SESSION = "copilot_session"
    CLI_LOG = "cli_log"
    CLI_LOG_SETTINGS = "cli_log_settings"
    TRIGGER_LOG = "trigger_log"
    SCAN_LOG = "scan_log"
    INDEX_LOG = "index_log"
    DOC_DB = "doc_db"
    RECORD_ERROR = "record_error"
    TEXT_FILE = "text_file"
    MARKDOWN = "markdown"
    MARKDOWN_INDEX = "markdown_index"
    SPEC = "spec"
    PROMPT = "prompt"
    PROMPT_COMPLETION = "prompt_completion"
    CONVERSATION = "conversation"
    WHITEBOARD = "whiteboard"
    AGENT_TRACE = "agent_trace"
    DYNAMIC_WORKFLOW = "dynamic_workflow"
    # A Claude Code workflow *run* — the provider's wf_<runId>.json journal,
    # parsed & served like a worker transcript/session (worker_type "workflow").
    WORKFLOW_RUN = "workflow_run"
    USAGE_REPORT = "usage_report"
    ASSET_CLEANUP_REPORT = "asset_cleanup_report"
    DATASET = "dataset"
    # A reusable slide-deck template — a folder of layout HTML components +
    # shared design tokens under assets/deck-templates/ (see the decker skill).
    DECK_TEMPLATE = "deck_template"
    # A generated presentation — a folder under assets/decks/ holding the
    # self-contained deck HTML + its deck.json build record (see decker skill).
    DECK = "deck"
    # A flat tabular file asset — a .csv (editable) or .xlsx (read-only view)
    # discovered anywhere in a project, rendered in a grid editor.
    SPREADSHEET = "spreadsheet"
    FLOWPAD_DIAGNOSIS = "flowpad_diagnosis"
    COLLABORATION_ROOM = "collaboration_room"
    # A host/guest remote-execution session that lives inside a CollaborationRoom
    # (alongside its files/assets): guest sends Prompts, host's worker returns
    # PromptCompletions. See builtin/remote_worker_session.py.
    REMOTE_WORKER_SESSION = "remote_worker_session"
    # Transient indexer waypoints — fan-out scaffolding, never persisted.
    USER_HOME_FOLDER = "user_home_folder"
    REAL_PROJECT_CWD = "real_project_cwd"
    SYSTEM_ROOT = "system_root"
    CWD_ROOT = "cwd_root"
    FOLDER = "folder"
    SECRET_ORIGIN = "secret_origin"
    CONTACTS_GROUP = "contacts_group"
    # A blessed dot-taxonomy tag name (flow_sdk/builtin/tag.py). Optional
    # enrichment — anonymous tags (plain strings) need no entity at all.
    TAG = "tag"
    WIKI = "wiki"
    WIKI_ENTRY = "wiki_entry"

    # ── DB / hub entity types (formerly BuiltinEntityType-only) ──────────────
    USER = "user"
    VISITOR = "visitor"
    APP_HOST = "app_host"
    TEAM = "team"
    GROUP = "group"
    ORGANIZATION = "organization"
    WORKSPACE = "workspace"
    PAGE = "page"
    INVITATION = "invitation"
    MENTION = "mention"
    CONNECTION = "connection"
    EXTENSION = "extension"
    FUNC = "func"
    SYNC_SERVICE = "sync_service"
    PLUGIN_MANIFEST = "plugin_manifest"
    FLOWPAD_SERVICE = "flowpad_service"
    STORAGE = "storage_device"
    FLOW_FILE = "flow_file"
    MICRO_APP = "micro_app"
    WEB_DOMAIN = "web_domain"
    JOB = "job"
    SYSTEM_JOB = "system_job"
    JOB_EXECUTION = "job_execution"
    API_KEY = "api_key"
    CODE_REF = "code_ref"
    AGENT_HOOK = "agent_hook"
    TRIGGER = "trigger"
    PROCESS_RESULT = "process_result"
    CRON_EVENT = "cron_event"
    FLOW_MESSAGE = "flow_message"
    # ── Flow-graph slice (GraphWorkflowManager) — DB-only entities, no asset_ref ──────
    # A station in the flow graph: binds a program (skill/callback/instruction)
    # to execution defaults; executions are separate AgenticProcess entities.
    GRAPH_WORKFLOW_NODE = "graph_workflow_node"
    # A folder-backed flow document (graph.json + display.json + scripts/ +
    # runs/). NOTE: "flow" stays reserved by the retired conversational Flow.
    GRAPH_WORKFLOW = "graph_workflow"
    # One execution of an GraphWorkflow — row is start/end bookkeeping; the full
    # trace lives in the flow folder's runs/<id>.jsonl.
    GRAPH_WORKFLOW_RUN = "graph_workflow_run"
    # A folder-backed guided-onboarding document (graph.json of guided_step
    # nodes + child *.html pages). Runs on the GraphWorkflowManager engine like an
    # GraphWorkflow, but typed separately so it stays out of the Flows list.
    JOURNEY = "journey"
    # A user's private progress through a Journey (DB-only, one per user+journey).
    JOURNEY_JOURNAL = "journey_journal"
    # A folder-backed support desk PORTAL: guides plus a helpdesk.json naming the
    # hub project that owns the ticket queue. A repo declares itself a help desk
    # by shipping one, so cloning it as a context folder is what gives a project
    # a help desk — there is no separate "add help desk" flow.
    HELPDESK = "helpdesk"
    # A received, staged bundle attachment awaiting explicit install
    # (DB-only entity — no TypeInfo/RecordType; see builtin/message_attachment.py).
    MESSAGE_ATTACHMENT = "message_attachment"
    TEAM_SPACE = "team_space"
    NOTIFICATION = "notification"
    # The @local singleton owning the inbox unread projection (see
    # builtin/inbox_manager.py + flow_sdk/inbox). DB-only, not user-creatable.
    INBOX_MANAGER = "inbox_manager"
    RUN = "run"
    # A file on disk outside the record store (DB-only; SemanticLock targets).
    FILE = "file"
    # A content-panel tab — DB-only placement record keyed by a DockPointer
    # hash (docs/tab-management.md). Minted on demand (Tab.ensure_for).
    TAB = "tab"
    # One record ingested from a cloud DataSource (a feed entry, a chat
    # message). Generic and discriminated by `kind`, NOT one type per provider
    # — the inbox projection has to be one queryable table.
    SOURCE_ITEM = "source_item"
    # A configured remote system of record we sync from (flow_sdk/ingest).
    DATA_SOURCE = "data_source"
    # One independently-checkpointed stream within a DataSource — a feed URL, a
    # channel. DB-only: written every poll, so it must never touch disk.
    DATA_SOURCE_CURSOR = "data_source_cursor"
    #: The AUTHORED half of a source — a folder asset describing what a source
    #: is. ``DATA_SOURCE`` is the configured instance; this is its definition.
    DATA_SOURCE_SPEC = "data_source_spec"
    # One thread of ingested cloud messages (a Gmail thread, a Slack
    # `thread_ts`). MANY threads may point at ONE conversation — that is the
    # merge seam, and why the conversation id is not derived from the thread.
    MESSAGE_THREAD = "message_thread"
    # Entity types that previously had no enum member (string-literal `type`).
    # Retired: Artifact composition now uses canonical parent_type_id. Keep the
    # persisted value parseable, but do not register a public entity surface.
    ARTIFACT_RELATION = "artifact_relation"
    KNOWLEDGE_BASE = "knowledge_base"
    # A frozen snapshot of the global context (a list of typeids) — the saved
    # "context" half of an automation (agentic process = prompt + context).
    GRAPH_CONTEXT = "graph_context"

    # ── Skillit ──────────────────────────────────────────────────────────────
    SKILLIT_SESSION = "skillit_session"
    SKILLIT_CONFIG = "skillit_config"
