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
    RecordType.DYNAMIC_WORKFLOW,
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
    RecordType.DECK_TEMPLATE,
    RecordType.DECK,
    RecordType.SPREADSHEET,
    RecordType.USAGE_REPORT,
    RecordType.ASSET_CLEANUP_REPORT,
]


def build_default_indexer() -> FSIndexer:
    """Construct the canonical indexer: root set + all functions registered.

    Honors the ``indexer_backend`` toggle (env ``FLOWPAD_INDEXER_BACKEND`` >
    pref ``preferences.advanced.indexer_backend``): ``rust`` returns the
    RSIndexerAdapter behind the same surface (fail-open to FSIndexer when the
    binary doesn't resolve). Default is the Python FSIndexer.
    """
    rs = _maybe_rs_indexer()
    if rs is not None:
        # TypeInfo registry must still be complete — scan-projection callers
        # run from_disk_fn Python-side on the adapter's FSRefs.
        import flow_sdk.fs_store.indexer.registrations  # noqa: F401, PLC0415
        return rs
    # Ensure all TypeInfo metadata (slot fns, post_sync_fn, presentation) is
    # registered before any indexing/sync runs. Type metadata now lives in
    # schema/type_info/<type>_info.py (registered by register_all) rather than
    # self-registering on functions-module import, so building the indexer is
    # the chokepoint that guarantees a complete registry. Idempotent.
    import flow_sdk.fs_store.indexer.registrations  # noqa: F401, PLC0415
    from flow_sdk.fs_store.indexer.functions.agent import agent_fn
    from flow_sdk.fs_store.indexer.functions.agent_trace import agent_trace_fn
    from flow_sdk.fs_store.indexer.functions.claude_command import command_fn
    from flow_sdk.fs_store.indexer.functions.claude_hook import (
        claude_hook_files_extras_fn,
        claude_hook_files_fn,
        hooks_in_settings_fn,
    )
    from flow_sdk.fs_store.indexer.functions.claude_md import (
        claude_md_in_claude_subdir_fn,
        claude_md_in_project_root_fn,
    )
    from flow_sdk.fs_store.indexer.functions.claude_memory import claude_memory_fn
    from flow_sdk.fs_store.indexer.functions.claude_plan import claude_plan_fn

    # Import locally to keep this module import-light at package-init time.
    from flow_sdk.fs_store.indexer.functions.claude_projects import claude_projects_fn
    from flow_sdk.fs_store.indexer.functions.claude_rules import claude_rules_fn
    from flow_sdk.fs_store.indexer.functions.claude_sessions import claude_sessions_fn
    from flow_sdk.fs_store.indexer.functions.codex_projects import codex_projects_fn
    from flow_sdk.fs_store.indexer.functions.codex_sessions import codex_sessions_fn
    from flow_sdk.fs_store.indexer.functions.copilot_sessions import copilot_sessions_fn
    from flow_sdk.fs_store.indexer.functions.dynamic_workflows import dynamic_workflows_fn
    from flow_sdk.fs_store.indexer.functions.markdown import (
        markdown_flat_fn,
        markdown_in_folder_fn,
    )
    from flow_sdk.fs_store.indexer.functions.mcp_server import (
        mcp_servers_in_file_fn,
        mcp_source_files_fn,
    )
    from flow_sdk.fs_store.indexer.functions.plugin import plugin_fn
    from flow_sdk.fs_store.indexer.functions.project_folder_walker import (
        project_folder_walker_fn,
    )
    from flow_sdk.fs_store.indexer.functions.prompt import prompt_project_fn
    from flow_sdk.fs_store.indexer.functions.repo_assets import repo_assets_fn
    from flow_sdk.fs_store.indexer.functions.skill import skill_fn, skill_in_folder_fn
    from flow_sdk.fs_store.indexer.functions.secret_origin import secret_origin_in_folder_fn
    from flow_sdk.fs_store.indexer.functions.spreadsheet import spreadsheet_in_folder_fn
    from flow_sdk.fs_store.indexer.functions.todo import todo_fn
    from flow_sdk.fs_store.indexer.functions.usage_report import usage_report_fn
    from flow_sdk.fs_store.indexer.functions.asset_cleanup_report import asset_cleanup_report_fn
    from flow_sdk.fs_store.indexer.functions.whiteboard import whiteboard_fn
    from flow_sdk.fs_store.indexer.functions.agentic_flow import agentic_flow_fn
    from flow_sdk.fs_store.indexer.functions.journey import journey_fn
    from flow_sdk.fs_store.indexer.functions.workflow_run import workflow_run_fn

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
    idx.add_function(RecordType.USER_HOME_FOLDER, agentic_flow_fn, RecordType.AGENTIC_FLOW)
    idx.add_function(RecordType.USER_HOME_FOLDER, journey_fn, RecordType.JOURNEY)
    idx.add_function(RecordType.USER_HOME_FOLDER, agent_trace_fn, RecordType.AGENT_TRACE)
    # Workflow run journals live at ~/.claude/projects/<slug>/<sid>/workflows/wf_*.json.
    idx.add_function(RecordType.USER_HOME_FOLDER, workflow_run_fn, RecordType.WORKFLOW_RUN)
    idx.add_function(RecordType.USER_HOME_FOLDER, usage_report_fn, RecordType.USAGE_REPORT)
    idx.add_function(RecordType.USER_HOME_FOLDER, asset_cleanup_report_fn, RecordType.ASSET_CLEANUP_REPORT)
    idx.add_function(RecordType.USER_HOME_FOLDER, agent_fn, RecordType.AGENT)
    # Dynamic workflows (.js) live beside the .md AMD workflows in .claude/workflows/.
    idx.add_function(RecordType.USER_HOME_FOLDER, dynamic_workflows_fn, RecordType.DYNAMIC_WORKFLOW)
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
    idx.add_function(RecordType.REAL_PROJECT_CWD, prompt_project_fn, RecordType.PROMPT)
    idx.add_function(RecordType.REAL_PROJECT_CWD, skill_fn, RecordType.SKILL)
    idx.add_function(RecordType.REAL_PROJECT_CWD, whiteboard_fn, RecordType.WHITEBOARD)
    idx.add_function(RecordType.REAL_PROJECT_CWD, agentic_flow_fn, RecordType.AGENTIC_FLOW)
    idx.add_function(RecordType.REAL_PROJECT_CWD, journey_fn, RecordType.JOURNEY)
    idx.add_function(RecordType.REAL_PROJECT_CWD, agent_trace_fn, RecordType.AGENT_TRACE)
    idx.add_function(RecordType.REAL_PROJECT_CWD, usage_report_fn, RecordType.USAGE_REPORT)
    idx.add_function(RecordType.REAL_PROJECT_CWD, asset_cleanup_report_fn, RecordType.ASSET_CLEANUP_REPORT)
    idx.add_function(RecordType.REAL_PROJECT_CWD, agent_fn, RecordType.AGENT)
    idx.add_function(RecordType.REAL_PROJECT_CWD, dynamic_workflows_fn, RecordType.DYNAMIC_WORKFLOW)
    idx.add_function(RecordType.REAL_PROJECT_CWD, project_folder_walker_fn, RecordType.FOLDER)
    idx.add_function(RecordType.REAL_PROJECT_CWD, claude_hook_files_fn, RecordType.CLAUDE_HOOK_SOURCE)
    idx.add_function(RecordType.REAL_PROJECT_CWD, mcp_source_files_fn, RecordType.MCP_SERVER_SOURCE)
    idx.add_function(RecordType.REAL_PROJECT_CWD, command_fn, RecordType.COMMAND)

    # SYSTEM_ROOT (flowpad_assistant) expanders
    idx.add_function(RecordType.SYSTEM_ROOT, skill_fn, RecordType.SKILL)
    idx.add_function(RecordType.SYSTEM_ROOT, whiteboard_fn, RecordType.WHITEBOARD)
    idx.add_function(RecordType.SYSTEM_ROOT, agentic_flow_fn, RecordType.AGENTIC_FLOW)
    idx.add_function(RecordType.SYSTEM_ROOT, journey_fn, RecordType.JOURNEY)
    idx.add_function(RecordType.SYSTEM_ROOT, agent_fn, RecordType.AGENT)
    idx.add_function(RecordType.SYSTEM_ROOT, project_folder_walker_fn, RecordType.FOLDER)

    # CWD_ROOT expanders
    idx.add_function(RecordType.CWD_ROOT, claude_plan_fn, RecordType.PLAN)
    idx.add_function(RecordType.CWD_ROOT, claude_rules_fn, RecordType.CLAUDE_RULES)
    idx.add_function(RecordType.CWD_ROOT, skill_fn, RecordType.SKILL)
    idx.add_function(RecordType.CWD_ROOT, whiteboard_fn, RecordType.WHITEBOARD)
    idx.add_function(RecordType.CWD_ROOT, agent_fn, RecordType.AGENT)
    idx.add_function(RecordType.CWD_ROOT, dynamic_workflows_fn, RecordType.DYNAMIC_WORKFLOW)
    idx.add_function(RecordType.CWD_ROOT, command_fn, RecordType.COMMAND)
    idx.add_function(RecordType.CWD_ROOT, project_folder_walker_fn, RecordType.FOLDER)
    idx.add_function(RecordType.CWD_ROOT, mcp_source_files_fn, RecordType.MCP_SERVER_SOURCE)

    # Repo assets: the recursive agentic-assets/<type> hierarchy. One walker
    # discovers the whole nested tree per scope root (in-function recursion), so
    # it registers on the roots only (not per repo type). output_type=None → it
    # always runs and emits many types; each is materialized by its own type.
    for _root in (
        RecordType.USER_HOME_FOLDER,
        RecordType.REAL_PROJECT_CWD,
        RecordType.SYSTEM_ROOT,
        RecordType.CWD_ROOT,
    ):
        idx.add_function(_root, repo_assets_fn)

    # FOLDER (transient scaffold emitted by project_folder_walker_fn) expanders
    idx.add_function(RecordType.FOLDER, markdown_in_folder_fn, RecordType.MARKDOWN)
    idx.add_function(RecordType.FOLDER, skill_in_folder_fn, RecordType.SKILL)
    idx.add_function(RecordType.FOLDER, spreadsheet_in_folder_fn, RecordType.SPREADSHEET)
    idx.add_function(RecordType.FOLDER, secret_origin_in_folder_fn, RecordType.SECRET_ORIGIN)
    idx.add_function(RecordType.CWD_ROOT, claude_hook_files_fn, RecordType.CLAUDE_HOOK_SOURCE)

    # Stage 2 of recursive hook walk: descend into each settings.json source
    # file emitted above and emit one CLAUDE_HOOK FSRef per hook entry.
    idx.add_function(RecordType.CLAUDE_HOOK_SOURCE, hooks_in_settings_fn, RecordType.CLAUDE_HOOK)

    # Stage 2 of recursive MCP walk: descend into each .mcp.json source file
    # and emit one MCP_SERVER FSRef per server entry (with json_path).
    idx.add_function(RecordType.MCP_SERVER_SOURCE, mcp_servers_in_file_fn, RecordType.MCP_SERVER)

    return idx


def _maybe_rs_indexer():
    """Return an RSIndexerAdapter when the instance selects the Rust backend
    AND the external binary resolves; else None (Python FSIndexer).

    Fail-open by design: a selected-but-unresolvable Rust backend logs one
    warning and falls back to Python, mirroring ``vendored_flow_rs_enabled``.
    The custom-slice builders (project_list, single-file self-heal) always
    build FSIndexer directly and are unaffected by this toggle.
    """
    from flow_sdk.fs_store.indexer.rs_adapter import (  # noqa: PLC0415
        RSIndexerAdapter,
        resolve_rs_indexer_bin,
        rs_backend_selected,
    )

    try:
        if not rs_backend_selected():
            return None
        bin_path = resolve_rs_indexer_bin()
        if bin_path is None:
            import logging  # noqa: PLC0415
            logging.warning(
                "indexer_backend=rust selected but no usable binary "
                "(set FLOWPAD_RS_INDEXER_BIN); using the Python FSIndexer"
            )
            return None
        return RSIndexerAdapter(bin_path)
    except Exception:
        import logging  # noqa: PLC0415
        logging.warning("RSIndexer backend selection failed; using FSIndexer", exc_info=True)
        return None


_shared: FSIndexer | None = None


def get_shared_indexer() -> FSIndexer:
    """Return the process-wide indexer, lazily constructed on first call.

    The backend toggle lives in ``build_default_indexer`` so every caller —
    this singleton AND direct ``build_default_indexer()`` users — honors it.
    """
    global _shared
    if _shared is None:
        _shared = build_default_indexer()
    return _shared


def reset_shared_indexer() -> None:
    """Clear the cached instance — for tests that need a fresh indexer."""
    global _shared
    _shared = None
