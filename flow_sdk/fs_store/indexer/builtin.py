"""Canonical wiring for the production FSIndexer.

Consolidates every registration (previously duplicated in test harnesses) into
one place. The HTTP handlers, search reindex, and the parity tests all pull
from here via ``get_shared_indexer()``.
"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING

from flow_sdk.fs_store.indexer.index_function import FSIndexer
from flow_sdk.fs_store.indexer.roots import default_roots
from flow_sdk.fs_store.record_types import RecordType

if TYPE_CHECKING:
    from flow_sdk.fs_store.indexer.auto_index import ScanMode

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


def build_default_indexer(scan_mode: "ScanMode | None" = None) -> FSIndexer:
    """Construct the canonical indexer: root set + all functions registered.

    Honors the ``indexer_backend`` toggle (env ``FLOWPAD_INDEXER_BACKEND`` >
    pref ``preferences.advanced.indexer_backend``): ``rust`` returns the
    RSIndexerAdapter behind the same surface (fail-open to FSIndexer when the
    binary doesn't resolve). Default is the Python FSIndexer.

    ``scan_mode`` selects where the Python backend's *discovery* phase runs
    (``preferences.auto_index.index_function``). Pass it explicitly to pin the
    mode — ``scan_child`` MUST do so, since defaulting there would re-read the
    preference, resolve SUBPROCESS again, and fork-bomb.
    """
    rs = _maybe_rs_indexer()
    if rs is not None:
        # TypeInfo registry must still be complete — scan-projection callers
        # run from_disk_fn Python-side on the adapter's FSRefs.
        import flow_sdk.fs_store.indexer.registrations  # noqa: F401, PLC0415
        # `scan_mode` is a no-op here: RSIndexerAdapter is not an FSIndexer
        # subclass and its scan already runs out-of-process in the Rust binary.
        if scan_mode is not None:
            import logging  # noqa: PLC0415
            logging.info(
                "indexer_backend=rust is active; index_function=%s is a no-op "
                "(the Rust binary already scans out-of-process)", scan_mode.value,
            )
        return rs
    # Ensure all TypeInfo metadata (slot fns, post_sync_fn, presentation) is
    # registered before any indexing/sync runs. Type metadata now lives in
    # schema/type_info/<type>_info.py (registered by register_all) rather than
    # self-registering on functions-module import, so building the indexer is
    # the chokepoint that guarantees a complete registry. Idempotent.
    import flow_sdk.fs_store.indexer.registrations  # noqa: F401, PLC0415
    from flow_sdk.fs_store.indexer.functions.agent import agent_fn
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
    from flow_sdk.fs_store.indexer.functions.repo_assets import repo_assets_fn
    from flow_sdk.fs_store.indexer.functions.secret_origin import secret_origin_in_folder_fn
    from flow_sdk.fs_store.indexer.functions.skill import skill_fn, skill_in_folder_fn
    from flow_sdk.fs_store.indexer.functions.spreadsheet import spreadsheet_in_folder_fn
    from flow_sdk.fs_store.indexer.functions.todo import todo_fn
    from flow_sdk.fs_store.indexer.functions.workflow_run import workflow_run_fn
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    # Transcript handlers are opt-in (full-JSONL parse is expensive — see
    # flow_sdk/fs_store/transcript_indexer/).
    # Default is the in-process walk. The auto-index preference is applied only
    # by get_auto_scan_indexer(), so a manual index is never silently displaced.
    cls = FSIndexer if scan_mode is None else _indexer_class_for(scan_mode)
    idx = cls(
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
    # Harness-ingest walker, NOT placement: ``~/.claude/plans/`` is Claude Code's
    # own plan-mode output directory, so flowpad reads it the same way
    # ``claude_sessions_fn`` reads ``~/.claude/projects/``. Flowpad's OWN plans are
    # repo assets (``agentic-assets/plan/``) found by ``repo_assets_fn`` — which is
    # why this is registered on user scope only.
    idx.add_function(RecordType.USER_HOME_FOLDER, claude_plan_fn, RecordType.PLAN)
    idx.add_function(RecordType.USER_HOME_FOLDER, claude_md_in_claude_subdir_fn, RecordType.CLAUDE_MD)
    idx.add_function(RecordType.USER_HOME_FOLDER, claude_rules_fn, RecordType.CLAUDE_RULES)
    idx.add_function(RecordType.USER_HOME_FOLDER, skill_fn, RecordType.SKILL)
    # Workflow run journals live at ~/.claude/projects/<slug>/<sid>/workflows/wf_*.json.
    idx.add_function(RecordType.USER_HOME_FOLDER, workflow_run_fn, RecordType.WORKFLOW_RUN)
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
    idx.add_function(RecordType.REAL_PROJECT_CWD, claude_md_in_project_root_fn, RecordType.CLAUDE_MD)
    idx.add_function(RecordType.REAL_PROJECT_CWD, claude_rules_fn, RecordType.CLAUDE_RULES)
    idx.add_function(RecordType.REAL_PROJECT_CWD, skill_fn, RecordType.SKILL)
    idx.add_function(RecordType.REAL_PROJECT_CWD, agent_fn, RecordType.AGENT)
    idx.add_function(RecordType.REAL_PROJECT_CWD, dynamic_workflows_fn, RecordType.DYNAMIC_WORKFLOW)
    idx.add_function(RecordType.REAL_PROJECT_CWD, project_folder_walker_fn, RecordType.FOLDER)
    idx.add_function(RecordType.REAL_PROJECT_CWD, claude_hook_files_fn, RecordType.CLAUDE_HOOK_SOURCE)
    idx.add_function(RecordType.REAL_PROJECT_CWD, mcp_source_files_fn, RecordType.MCP_SERVER_SOURCE)
    idx.add_function(RecordType.REAL_PROJECT_CWD, command_fn, RecordType.COMMAND)

    # SYSTEM_ROOT (flowpad_assistant) expanders
    idx.add_function(RecordType.SYSTEM_ROOT, skill_fn, RecordType.SKILL)
    idx.add_function(RecordType.SYSTEM_ROOT, agent_fn, RecordType.AGENT)
    idx.add_function(RecordType.SYSTEM_ROOT, project_folder_walker_fn, RecordType.FOLDER)

    # CWD_ROOT expanders. A cloned repo is scanned as a CWD_ROOT
    # (``_index_additional_dir``), so a journey a project SHIPS in
    # ``agentic-assets/journey/`` only becomes an entity — and can only
    # auto-launch — because ``repo_assets_fn`` below runs for this root too.
    idx.add_function(RecordType.CWD_ROOT, claude_rules_fn, RecordType.CLAUDE_RULES)
    idx.add_function(RecordType.CWD_ROOT, skill_fn, RecordType.SKILL)
    idx.add_function(RecordType.CWD_ROOT, agent_fn, RecordType.AGENT)
    idx.add_function(RecordType.CWD_ROOT, dynamic_workflows_fn, RecordType.DYNAMIC_WORKFLOW)
    idx.add_function(RecordType.CWD_ROOT, command_fn, RecordType.COMMAND)
    idx.add_function(RecordType.CWD_ROOT, project_folder_walker_fn, RecordType.FOLDER)
    idx.add_function(RecordType.CWD_ROOT, mcp_source_files_fn, RecordType.MCP_SERVER_SOURCE)

    # Repo assets: the recursive agentic-assets/<type> hierarchy. One walker
    # discovers the whole nested tree per scope root (in-function recursion), so
    # it registers on the roots only (not per repo type). Its explicit output
    # set keeps typed scans prunable without pretending this multi-output walker
    # is unknown.
    #
    # This is the ONLY discovery path for every flowpad-native asset — task, spec,
    # deck, whiteboard, journey, graph_workflow, agent_trace, the two report types,
    # prompt, plan, and INSTALLED (received) transcripts. Each of those used to
    # carry a bespoke walker over a hand-written ``.claude/<something>`` path;
    # those directories were never part of any harness's vocabulary, so the types
    # moved to REPO and their walkers were deleted rather than repointed. A new
    # repo type enrolls by declaring ``asset_class="repo"`` — no edit here.
    repo_output_types = frozenset(RecordType(type_name) for type_name in SchemaRegistry.get_repo_types())
    for _root in (
        RecordType.USER_HOME_FOLDER,
        RecordType.REAL_PROJECT_CWD,
        RecordType.SYSTEM_ROOT,
        RecordType.CWD_ROOT,
    ):
        idx.add_function(_root, repo_assets_fn, repo_output_types)

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


ENV_INDEX_SCAN_MODE = "FLOWPAD_INDEX_SCAN_MODE"


def selected_scan_mode() -> "ScanMode":
    """Resolve ``preferences.auto_index.index_function``: env > pref > default.

    The env override exists so tests and harnesses can pin a mode without writing
    preferences. Anything unrecognized degrades to the default rather than raising
    into indexer construction — ``coerce_enum`` owns that policy, shared with the
    other two auto-index enums.
    """
    from flow_sdk.fs_store.indexer.auto_index import (  # noqa: PLC0415
        DEFAULT_AUTO_INDEX_FUNCTION,
        PREF_AUTO_INDEX_FUNCTION,
        ScanMode,
        coerce_enum,
    )
    from flow_sdk.preferences import read_instance_pref  # noqa: PLC0415

    raw = os.environ.get(ENV_INDEX_SCAN_MODE, "").strip() or read_instance_pref(
        PREF_AUTO_INDEX_FUNCTION, DEFAULT_AUTO_INDEX_FUNCTION
    )
    return coerce_enum(ScanMode, raw, DEFAULT_AUTO_INDEX_FUNCTION)


def _indexer_class_for(mode: "ScanMode") -> type[FSIndexer]:
    """The FSIndexer class implementing ``mode``.

    Imported lazily so ``subprocess_scan`` (and through it the NDJSON protocol)
    stays off the import path when the thread mode is selected.
    """
    from flow_sdk.fs_store.indexer.auto_index import ScanMode  # noqa: PLC0415

    if mode is ScanMode.SUBPROCESS:
        from flow_sdk.fs_store.indexer.subprocess_scan import (  # noqa: PLC0415
            SubprocessScanIndexer,
        )

        return SubprocessScanIndexer
    return FSIndexer


_auto_scan_shared: FSIndexer | None = None


def get_auto_scan_indexer() -> FSIndexer:
    """The indexer the AUTO-index path uses, honoring ``index_function``.

    Kept separate from ``get_shared_indexer`` on purpose. ``index_function`` is an
    auto-index preference — sitting in the ``auto_index`` category and hidden
    behind its ``enabled`` toggle — so it must not silently change how a *manual*
    "Index" click walks the disk. Every other caller keeps the default in-process
    walk regardless of this setting.

    Returns the shared singleton unchanged for the thread mode, so the common case
    builds no second indexer.
    """
    global _auto_scan_shared
    from flow_sdk.fs_store.indexer.auto_index import ScanMode  # noqa: PLC0415

    if selected_scan_mode() is not ScanMode.SUBPROCESS:
        return get_shared_indexer()
    if _auto_scan_shared is None or not isinstance(
        _auto_scan_shared, _indexer_class_for(ScanMode.SUBPROCESS)
    ):
        _auto_scan_shared = build_default_indexer(scan_mode=ScanMode.SUBPROCESS)
    return _auto_scan_shared


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
    """Clear the cached instances — for tests, and after a backend pref change.

    Also drops the auto-scan indexer and re-arms child probing, so flipping
    ``index_function`` takes effect without a restart even if a previous child
    spawn had latched as unavailable.
    """
    global _shared, _auto_scan_shared
    _shared = None
    _auto_scan_shared = None
    try:
        from flow_sdk.fs_store.indexer.subprocess_scan import (  # noqa: PLC0415
            reset_child_availability,
        )

        reset_child_availability()
    except Exception:  # noqa: BLE001 — module may not be importable in a child
        pass
