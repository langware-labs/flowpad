"""Canonical wiring for the production FSIndexer.

Consolidates every registration (previously duplicated in test harnesses) into
one place. The HTTP handlers, search reindex, and the parity tests all pull
from here via ``get_shared_indexer()``.
"""

from __future__ import annotations

from flow_sdk.fs_store.indexer.index_function import FSIndexer
from flow_sdk.fs_store.indexer.roots import default_roots
from flow_sdk.fs_store.record_types import RecordType


# Terminal record types the indexer writes via Record.from_fsref.
# Used by rebuild mode in the index handler to know what to clear.
INDEXABLE_TYPES: list[RecordType] = [
    RecordType.CLAUDE_SESSION,
    RecordType.PROJECT,
    RecordType.CODEX_SESSION,
    RecordType.CODEX_PROJECT,
    RecordType.COPILOT_SESSION,
    RecordType.PLAN,
    RecordType.CLAUDE_MD,
    RecordType.CLAUDE_RULES,
    RecordType.SPEC,
    RecordType.SKILL,
    RecordType.AGENT,
    RecordType.WORKFLOW,
    RecordType.COMMAND,
    RecordType.CLAUDE_MEMORY,
    RecordType.MARKDOWN,
    RecordType.CLAUDE_HOOK,
    RecordType.MCP_SERVER,
    RecordType.PLUGIN,
    RecordType.TODO_FILE,
    RecordType.TASK,
    RecordType.WHITEBOARD,
    RecordType.DATASET,
    RecordType.USAGE_REPORT,
]


def build_default_indexer() -> FSIndexer:
    """Construct an FSIndexer with the canonical root set + all functions registered."""
    # Ensure all TypeInfo metadata (slot fns, post_sync_fn, presentation) is
    # registered before any indexing/sync runs. Type metadata now lives in
    # schema/type_info/<type>_info.py (registered by register_all) rather than
    # self-registering on functions-module import, so building the indexer is
    # the chokepoint that guarantees a complete registry. Idempotent.
    import flow_sdk.fs_store.indexer.registrations  # noqa: F401, PLC0415
    # Import locally to keep this module import-light at package-init time.
    from flow_sdk.fs_store.indexer.functions.claude_projects import claude_projects_fn
    from flow_sdk.fs_store.indexer.functions.claude_sessions import claude_sessions_fn
    from flow_sdk.fs_store.indexer.functions.codex_projects import codex_projects_fn
    from flow_sdk.fs_store.indexer.functions.codex_sessions import codex_sessions_fn
    from flow_sdk.fs_store.indexer.functions.copilot_sessions import copilot_sessions_fn
    from flow_sdk.fs_store.indexer.functions.claude_plan import claude_plan_fn
    from flow_sdk.fs_store.indexer.functions.claude_md import (
        claude_md_in_claude_subdir_fn, claude_md_in_project_root_fn,
    )
    from flow_sdk.fs_store.indexer.functions.claude_rules import claude_rules_fn
    from flow_sdk.fs_store.indexer.functions.spec import spec_project_fn
    from flow_sdk.fs_store.indexer.functions.prompt import prompt_project_fn
    from flow_sdk.fs_store.indexer.functions.skill import skill_fn
    from flow_sdk.fs_store.indexer.functions.whiteboard import whiteboard_fn
    from flow_sdk.fs_store.indexer.functions.agent_trace import agent_trace_fn
    from flow_sdk.fs_store.indexer.functions.usage_report import usage_report_fn
    from flow_sdk.fs_store.indexer.functions.agent import agent_fn
    from flow_sdk.fs_store.indexer.functions.workflow import (
        workflow_fn, workflow_frontmatter_fn,
    )
    from flow_sdk.fs_store.indexer.functions.claude_command import command_fn
    from flow_sdk.fs_store.indexer.functions.claude_memory import claude_memory_fn
    from flow_sdk.fs_store.indexer.functions.markdown import (
        markdown_flat_fn, markdown_in_folder_fn,
    )
    from flow_sdk.fs_store.indexer.functions.project_folder_walker import (
        project_folder_walker_fn,
    )
    from flow_sdk.fs_store.indexer.functions.task import task_fn
    from flow_sdk.fs_store.indexer.functions.dataset import dataset_fn
    from flow_sdk.fs_store.indexer.functions.claude_hook import (
        claude_hook_files_fn, claude_hook_files_extras_fn, hooks_in_settings_fn,
    )
    from flow_sdk.fs_store.indexer.functions.mcp_server import (
        mcp_source_files_fn, mcp_servers_in_file_fn,
    )
    from flow_sdk.fs_store.indexer.functions.plugin import plugin_fn
    from flow_sdk.fs_store.indexer.functions.todo import todo_fn

    # Transcript handlers are opt-in (full-JSONL parse is expensive — see
    # flow_sdk/fs_store/transcript_indexer/).
    idx = FSIndexer(
        roots=default_roots(),
    )

    # USER_HOME_FOLDER expanders.
    #
    # NOTE: ``real_project_cwd_fn`` is intentionally NOT registered here.
    # Project-cwd fanout was previously implicit (any scan over USER_HOME would
    # silently discover + walk every Claude/Codex project tree), which made
    # ``?limit_types=N`` and ``scope_filter=None`` mean "walk the universe".
    # Project-cwd roots are now contributed explicitly by the scope filter via
    # ``_resolve_scoped_roots``: callers that want all-projects pass
    # ``ScopeFilter`` materialised by ``get_all_scope_filter()``, narrower
    # callers pass a narrower filter, and the indexer only walks what the
    # caller actually asked for.
    # output_type annotations let scan() skip a function when no requested
    # type is reachable from its output (e.g. ``?type=skill`` skips every
    # function whose output is FOLDER / MARKDOWN / TASK / …).
    idx.add_function(RecordType.USER_HOME_FOLDER, claude_projects_fn, RecordType.PROJECT)
    idx.add_function(RecordType.USER_HOME_FOLDER, claude_plan_fn, RecordType.PLAN)
    idx.add_function(RecordType.USER_HOME_FOLDER, claude_md_in_claude_subdir_fn, RecordType.CLAUDE_MD)
    idx.add_function(RecordType.USER_HOME_FOLDER, claude_rules_fn, RecordType.CLAUDE_RULES)
    idx.add_function(RecordType.USER_HOME_FOLDER, skill_fn, RecordType.SKILL)
    idx.add_function(RecordType.USER_HOME_FOLDER, whiteboard_fn, RecordType.WHITEBOARD)
    idx.add_function(RecordType.USER_HOME_FOLDER, agent_trace_fn, RecordType.AGENT_TRACE)
    idx.add_function(RecordType.USER_HOME_FOLDER, usage_report_fn, RecordType.USAGE_REPORT)
    idx.add_function(RecordType.USER_HOME_FOLDER, agent_fn, RecordType.AGENT)
    idx.add_function(RecordType.USER_HOME_FOLDER, workflow_fn, RecordType.WORKFLOW)
    idx.add_function(RecordType.USER_HOME_FOLDER, command_fn, RecordType.COMMAND)
    idx.add_function(RecordType.USER_HOME_FOLDER, markdown_flat_fn, RecordType.MARKDOWN)
    # Hook indexing is two-stage (recursive into-file walk):
    #   stage 1: <root> → CLAUDE_HOOK_SOURCE (one per settings.json-like file)
    #   stage 2: CLAUDE_HOOK_SOURCE → CLAUDE_HOOK (one per hook entry, with json_path)
    idx.add_function(RecordType.USER_HOME_FOLDER, claude_hook_files_fn, RecordType.CLAUDE_HOOK_SOURCE)
    idx.add_function(RecordType.USER_HOME_FOLDER, claude_hook_files_extras_fn, RecordType.CLAUDE_HOOK_SOURCE)
    # MCP servers are two-stage (source file → per-server, with json_path).
    idx.add_function(RecordType.USER_HOME_FOLDER, mcp_source_files_fn, RecordType.MCP_SERVER_SOURCE)
    # Plugins + todos are user-global single-file registries.
    idx.add_function(RecordType.USER_HOME_FOLDER, plugin_fn, RecordType.PLUGIN)
    idx.add_function(RecordType.USER_HOME_FOLDER, todo_fn, RecordType.TODO_FILE)
    # codex_projects_fn consolidates codex cwds into RecordType.PROJECT
    # (CODEX_PROJECT is a deprecated alias). Annotating it CODEX_PROJECT here
    # makes the type-gating dispatcher skip it for ``?type=project`` queries
    # and silently drop every Codex-discovered project.
    idx.add_function(RecordType.USER_HOME_FOLDER, codex_projects_fn, RecordType.PROJECT)
    idx.add_function(RecordType.USER_HOME_FOLDER, codex_sessions_fn, RecordType.CODEX_SESSION)
    idx.add_function(RecordType.USER_HOME_FOLDER, copilot_sessions_fn, RecordType.COPILOT_SESSION)

    # PROJECT (encoded ~/.claude/projects/<dir>) expanders
    idx.add_function(RecordType.PROJECT, claude_sessions_fn, RecordType.CLAUDE_SESSION)
    idx.add_function(RecordType.PROJECT, claude_memory_fn, RecordType.CLAUDE_MEMORY)

    # REAL_PROJECT_CWD (decoded cwd) expanders
    idx.add_function(RecordType.REAL_PROJECT_CWD, claude_plan_fn, RecordType.PLAN)
    idx.add_function(RecordType.REAL_PROJECT_CWD, claude_md_in_project_root_fn, RecordType.CLAUDE_MD)
    idx.add_function(RecordType.REAL_PROJECT_CWD, claude_rules_fn, RecordType.CLAUDE_RULES)
    idx.add_function(RecordType.REAL_PROJECT_CWD, spec_project_fn, RecordType.SPEC)
    idx.add_function(RecordType.REAL_PROJECT_CWD, prompt_project_fn, RecordType.PROMPT)
    idx.add_function(RecordType.REAL_PROJECT_CWD, skill_fn, RecordType.SKILL)
    idx.add_function(RecordType.REAL_PROJECT_CWD, whiteboard_fn, RecordType.WHITEBOARD)
    idx.add_function(RecordType.REAL_PROJECT_CWD, agent_trace_fn, RecordType.AGENT_TRACE)
    idx.add_function(RecordType.REAL_PROJECT_CWD, usage_report_fn, RecordType.USAGE_REPORT)
    idx.add_function(RecordType.REAL_PROJECT_CWD, agent_fn, RecordType.AGENT)
    idx.add_function(RecordType.REAL_PROJECT_CWD, workflow_fn, RecordType.WORKFLOW)
    idx.add_function(RecordType.REAL_PROJECT_CWD, project_folder_walker_fn, RecordType.FOLDER)
    idx.add_function(RecordType.REAL_PROJECT_CWD, task_fn, RecordType.TASK)
    idx.add_function(RecordType.REAL_PROJECT_CWD, dataset_fn, RecordType.DATASET)
    idx.add_function(RecordType.REAL_PROJECT_CWD, claude_hook_files_fn, RecordType.CLAUDE_HOOK_SOURCE)
    idx.add_function(RecordType.REAL_PROJECT_CWD, mcp_source_files_fn, RecordType.MCP_SERVER_SOURCE)
    idx.add_function(RecordType.REAL_PROJECT_CWD, command_fn, RecordType.COMMAND)

    # SYSTEM_ROOT (flowpad_assistant) expanders
    idx.add_function(RecordType.SYSTEM_ROOT, skill_fn, RecordType.SKILL)
    idx.add_function(RecordType.SYSTEM_ROOT, whiteboard_fn, RecordType.WHITEBOARD)
    idx.add_function(RecordType.SYSTEM_ROOT, agent_fn, RecordType.AGENT)
    idx.add_function(RecordType.SYSTEM_ROOT, project_folder_walker_fn, RecordType.FOLDER)

    # CWD_ROOT expanders
    idx.add_function(RecordType.CWD_ROOT, claude_plan_fn, RecordType.PLAN)
    idx.add_function(RecordType.CWD_ROOT, claude_rules_fn, RecordType.CLAUDE_RULES)
    idx.add_function(RecordType.CWD_ROOT, skill_fn, RecordType.SKILL)
    idx.add_function(RecordType.CWD_ROOT, whiteboard_fn, RecordType.WHITEBOARD)
    idx.add_function(RecordType.CWD_ROOT, agent_fn, RecordType.AGENT)
    idx.add_function(RecordType.CWD_ROOT, workflow_fn, RecordType.WORKFLOW)
    idx.add_function(RecordType.CWD_ROOT, command_fn, RecordType.COMMAND)
    idx.add_function(RecordType.CWD_ROOT, project_folder_walker_fn, RecordType.FOLDER)
    idx.add_function(RecordType.CWD_ROOT, mcp_source_files_fn, RecordType.MCP_SERVER_SOURCE)

    # FOLDER (transient scaffold emitted by project_folder_walker_fn) expanders
    idx.add_function(RecordType.FOLDER, markdown_in_folder_fn, RecordType.MARKDOWN)
    idx.add_function(RecordType.FOLDER, workflow_frontmatter_fn, RecordType.WORKFLOW)
    idx.add_function(RecordType.CWD_ROOT, claude_hook_files_fn, RecordType.CLAUDE_HOOK_SOURCE)

    # Stage 2 of recursive hook walk: descend into each settings.json source
    # file emitted above and emit one CLAUDE_HOOK FSRef per hook entry.
    idx.add_function(RecordType.CLAUDE_HOOK_SOURCE, hooks_in_settings_fn, RecordType.CLAUDE_HOOK)

    # Stage 2 of recursive MCP walk: descend into each .mcp.json source file
    # and emit one MCP_SERVER FSRef per server entry (with json_path).
    idx.add_function(RecordType.MCP_SERVER_SOURCE, mcp_servers_in_file_fn, RecordType.MCP_SERVER)

    return idx


_shared: FSIndexer | None = None


def get_shared_indexer() -> FSIndexer:
    """Return the process-wide indexer, lazily constructed on first call."""
    global _shared
    if _shared is None:
        _shared = build_default_indexer()
    return _shared


def reset_shared_indexer() -> None:
    """Clear the cached instance — for tests that need a fresh indexer."""
    global _shared
    _shared = None
