"""Value-stability guard for the single canonical ``EntityType`` enum.

Type string VALUES are persisted in the DB and on disk (``record.type``,
``TypeId.type``). They must NEVER change. This test pins every name→value pair;
if you rename a value you break existing data — update only with a migration.

Also asserts the back-compat aliases (``RecordType``, ``BuiltinEntityType``,
``SkillitRecordType``) resolve to the same class.
"""

from flow_sdk.schema.types import EntityType

EXPECTED = {
    "PROJECT": "project",
    "CLAUDE_SESSION": "claude_session",
    "TASK": "task",
    "RULE": "rule",
    "SKILL": "skill",
    "SUBAGENT": "subagent",
    # Launchable agent (identity + launch bundle) — additive member; the
    # subagent rename freed the noun, no existing value changed.
    "AGENT": "agent",
    "LOG": "log",
    "AGENTIC_PROCESS": "agentic_process",
    "ARTIFACT": "artifact",
    "DEPLOYMENT": "deployment",
    "BOOKMARK": "bookmark",
    "ANNOTATION": "annotation",
    "COMMENT": "comment",
    "APP_SECRET": "app_secret",
    "CLAUDE_ROOT": "claude_root",
    "ACCOUNT": "account",
    "HOOK": "hook",
    "HOOK_ENTRY": "hook_entry",
    "CLAUDE_HOOK": "claude_hook",
    "CLAUDE_HOOK_SOURCE": "claude_hook_source",
    "TODO_FILE": "todo_file",
    "TODO_ITEM": "todo_item",
    "PLAN": "plan",
    "CLAUDE_MEMORY": "claude_memory",
    "CLAUDE_RULES": "claude_rules",
    "COMMAND": "command",
    "MCP_SERVER": "mcp_server",
    "MCP_SERVER_SOURCE": "mcp_server_source",
    "PLUGIN": "plugin",
    "CLAUDE_MD": "claude_md",
    "HISTORY": "history",
    "HISTORY_ENTRY": "history_entry",
    "TRANSCRIPT_ENTRY": "transcript_entry",
    "TRANSCRIPT_PROGRESS": "transcript_entry:progress",
    "TRANSCRIPT_TOOL_USE": "transcript_entry:tool_use",
    "TRANSCRIPT_TOOL_RESULT": "transcript_entry:tool_result",
    "TRANSCRIPT_FILE_SNAPSHOT": "transcript_entry:file_snapshot",
    "TRANSCRIPT_QUEUE_OPERATION": "transcript_entry:queue_operation",
    "TRANSCRIPT_SUMMARY": "transcript_entry:summary",
    "TRANSCRIPT_CUSTOM_TITLE": "transcript_entry:custom_title",
    "TRANSCRIPT_PR_LINK": "transcript_entry:pr_link",
    "COMPUTE_NODE": "compute_node",
    "ENVIRONMENT": "environment",
    "SESSION_ANALYSIS": "session_analysis",
    "SESSION_CLASSIFICATION": "session_classification",
    "ACTIVE_SESSIONS": "active_sessions",
    "ACTIVE_SESSION": "active_session",
    "SHELL": "shell",
    "CLAUDE_DEBUG_LOG": "claude_debug_log",
    "CLAUDE_ERROR": "claude_error",
    "CLAUDE_SETTINGS": "claude_settings",
    "CLAUDE_SETTINGS_OAUTH": "claude_settings:oauth_account",
    "CLAUDE_SETTINGS_PROJECT": "claude_settings:project_entry",
    "CLAUDE_SETTINGS_MODEL_USAGE": "claude_settings:model_usage",
    "CLAUDE_SETTINGS_MCP_SERVER": "claude_settings:mcp_server_config",
    "CLAUDE_SETTINGS_FEATURE_FLAGS": "claude_settings:feature_flags",
    "CLAUDE_SETTINGS_TIPS_HISTORY": "claude_settings:tips_history",
    "CLAUDE_SETTINGS_SKILL_USAGE": "claude_settings:skill_usage",
    "CLAUDE_SETTINGS_GITHUB_REPOS": "claude_settings:github_repos",
    "CLAUDE_SETTINGS_JSON": "claude_settings_json",
    "CLAUDE_SETTINGS_JSON_PERMISSIONS": "claude_settings_json:permissions",
    "CLAUDE_SETTINGS_JSON_SANDBOX": "claude_settings_json:sandbox",
    "CLAUDE_SETTINGS_JSON_ATTRIBUTION": "claude_settings_json:attribution",
    "CLAUDE_MANAGED_SETTINGS": "claude_managed_settings",
    "CLAUDE_MCP_JSON": "claude_mcp_json",
    "CLAUDE_MCP_JSON_ENTRY": "claude_mcp_json:entry",
    "CODEX_SESSION": "codex_session",
    "CODEX_PROJECT": "codex_project",
    "CLI_LOG": "cli_log",
    "CLI_LOG_SETTINGS": "cli_log_settings",
    "TRIGGER_LOG": "trigger_log",
    "SCAN_LOG": "scan_log",
    "INDEX_LOG": "index_log",
    "DOC_DB": "doc_db",
    "RECORD_ERROR": "record_error",
    "TEXT_FILE": "text_file",
    "MARKDOWN": "markdown",
    "MARKDOWN_INDEX": "markdown_index",
    "SPEC": "spec",
    "PROMPT": "prompt",
    "CONVERSATION": "conversation",
    "WHITEBOARD": "whiteboard",
    "DATASET": "dataset",
    "SECRET_ORIGIN": "secret_origin",
    "COLLABORATION_ROOM": "collaboration_room",
    "USER_HOME_FOLDER": "user_home_folder",
    "REAL_PROJECT_CWD": "real_project_cwd",
    "SYSTEM_ROOT": "system_root",
    "CWD_ROOT": "cwd_root",
    "FOLDER": "folder",
    "USER": "user",
    "VISITOR": "visitor",
    "APP_HOST": "app_host",
    "TEAM": "team",
    "GROUP": "group",
    "ORGANIZATION": "organization",
    "WORKSPACE": "workspace",
    "PAGE": "page",
    "INVITATION": "invitation",
    "MENTION": "mention",
    "CONNECTION": "connection",
    "EXTENSION": "extension",
    "FUNC": "func",
    "CONTACTS_GROUP": "contacts_group",
    "SYNC_SERVICE": "sync_service",
    "PLUGIN_MANIFEST": "plugin_manifest",
    "FLOWPAD_SERVICE": "flowpad_service",
    "STORAGE": "storage_device",
    "FLOW_FILE": "flow_file",
    "MICRO_APP": "micro_app",
    "WEB_DOMAIN": "web_domain",
    "JOB": "job",
    "SYSTEM_JOB": "system_job",
    "JOB_EXECUTION": "job_execution",
    "API_KEY": "api_key",
    "CODE_REF": "code_ref",
    "AGENT_HOOK": "agent_hook",
    "TRIGGER": "trigger",
    "PROCESS_RESULT": "process_result",
    "CRON_EVENT": "cron_event",
    "FLOW_MESSAGE": "flow_message",
    # Staged bundle attachment awaiting explicit install (DB-only entity).
    "MESSAGE_ATTACHMENT": "message_attachment",
    "TEAM_SPACE": "team_space",
    "NOTIFICATION": "notification",
    "INBOX_MANAGER": "inbox_manager",
    "RUN": "run",
    "PROMPT_COMPLETION": "prompt_completion",
    "REMOTE_WORKER_SESSION": "remote_worker_session",
    # SemanticLock file targets (5a19f9e6) — additive member; the commit that
    # added it missed this freeze.
    "FILE": "file",
    "ARTIFACT_RELATION": "artifact_relation",
    "FS_ITEM": "fs_item",
    "KNOWLEDGE_BASE": "knowledge_base",
    "SKILLIT_SESSION": "skillit_session",
    "SKILLIT_CONFIG": "skillit_config",
    "COPILOT_SESSION": "copilot_session",
    "FLOWPAD_DIAGNOSIS": "flowpad_diagnosis",
    # Tab entity system + AgentTrace — additive members; the commits that added
    # them missed this freeze. New members are allowed; existing values stay frozen.
    "AGENT_TRACE": "agent_trace",
    "TAB": "tab",
    # GraphContext entity (0.2.67-fixes) — additive member; existing values stay frozen.
    "GRAPH_CONTEXT": "graph_context",
    # Usage-report feature (16b7936e) — additive member; brand-new type, no
    # existing value changed, so no migration. Existing values stay frozen.
    "USAGE_REPORT": "usage_report",
    # Asset-cleanup feature — additive member; brand-new type, no existing
    # value changed, so no migration.
    "ASSET_CLEANUP_REPORT": "asset_cleanup_report",
    # Additive members; brand-new types, no existing value changed, so no
    # migration. DYNAMIC_WORKFLOW's adding commit missed this freeze; WORKFLOW_RUN
    # is the workflow-run-as-transcript feature.
    "DYNAMIC_WORKFLOW": "dynamic_workflow",
    "WORKFLOW_RUN": "workflow_run",
    # Deck-template feature — additive member; brand-new type, no existing
    # value changed, so no migration.
    "DECK_TEMPLATE": "deck_template",
    # Deck and spreadsheet features (47d82b8e, 7531a7c0) — additive members;
    # brand-new types, no existing value changed, so no migration. Their
    # introducing commits missed this freeze.
    "DECK": "deck", "SPREADSHEET": "spreadsheet",
    # Tag vocabulary consolidation: blessed taxonomy tags are a first-class
    # entity type. Flow-graph v2 added the run model.
    "TAG": "tag",
    "WIKI": "wiki",
    "WIKI_ENTRY": "wiki_entry",
    "GRAPH_WORKFLOW": "graph_workflow", "GRAPH_WORKFLOW_NODE": "graph_workflow_node",
    "GRAPH_WORKFLOW_RUN": "graph_workflow_run",
    # Journeys (0.2.105): folder-backed guided-onboarding doc + per-user
    # DB-only journal — additive members, no existing value changed.
    "JOURNEY": "journey", "JOURNEY_JOURNAL": "journey_journal",
}


def test_entity_type_values_frozen():
    """Every member's persisted string value is pinned — no silent drift."""
    actual = {m.name: m.value for m in EntityType}
    assert actual == EXPECTED, (
        "EntityType name→value drift. Values are DB/FS-persisted; "
        "changing one requires a data migration, not a code edit."
    )


def test_back_compat_aliases_are_the_same_class():
    from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
    from flow_sdk.fs_store.record_types import RecordType, SkillitRecordType

    assert RecordType is EntityType
    assert BuiltinEntityType is EntityType
    assert SkillitRecordType is EntityType
    # shared members resolve to the same singleton
    assert RecordType.SUBAGENT is BuiltinEntityType.SUBAGENT
