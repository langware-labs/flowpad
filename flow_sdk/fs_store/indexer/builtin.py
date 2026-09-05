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


def indexable_types() -> list[RecordType]:
    """Terminal record types the production indexer writes.

    Derived from the shared indexer's registration graph
    (``FSIndexer.terminal_output_types``): every declared walker output that
    the registry can parse from disk. A new walker + ``from_disk_fn`` enrolls
    its type here with no edit — rebuild mode, orphan detection and
    ``?limit_types`` slicing all read this one derivation. Registry order.

    Memoized: the registration graph is fixed once an indexer is built, and
    ``reset_shared_indexer`` is the single invalidation point for both.
    """
    global _derived_types
    if _derived_types is None:
        idx = get_shared_indexer()
        derive = getattr(idx, "terminal_output_types", None)
        if derive is None:
            # The Rust adapter is not an FSIndexer, so the set comes from a
            # throwaway Python indexer carrying the identical graph. Building
            # one is ~50 `add_function` calls, and this is asked several times
            # per scan request — hence the memo, dropped by
            # `reset_shared_indexer` alongside the indexers themselves.
            idx = FSIndexer(roots=[])
            register_default_functions(idx)
            derive = idx.terminal_output_types
        _derived_types = derive()
    return list(_derived_types)


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
    # Transcript handlers are opt-in (full-JSONL parse is expensive — see
    # flow_sdk/fs_store/transcript_indexer/).
    # Default is the in-process walk. The auto-index preference is applied only
    # by get_auto_scan_indexer(), so a manual index is never silently displaced.
    cls = FSIndexer if scan_mode is None else _indexer_class_for(scan_mode)
    idx = cls(
        roots=default_roots(),
    )
    register_default_functions(idx)
    return idx


def register_default_functions(idx: FSIndexer) -> None:
    """Wire every production walker onto ``idx`` — the one registration graph.

    Split from ``build_default_indexer`` so a caller that needs the graph but
    not the roots (``indexable_types`` under the Rust backend) does not walk
    anything to get it.
    """
    import flow_sdk.fs_store.indexer.registrations  # noqa: F401, PLC0415
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

    # Import locally to keep this module import-light at package-init time.
    from flow_sdk.fs_store.indexer.functions.claude_projects import claude_projects_fn
    from flow_sdk.fs_store.indexer.functions.claude_sessions import claude_sessions_fn
    from flow_sdk.fs_store.indexer.functions.codex_projects import codex_projects_fn
    from flow_sdk.fs_store.indexer.functions.codex_sessions import codex_sessions_fn
    from flow_sdk.fs_store.indexer.functions.copilot_sessions import copilot_sessions_fn
    from flow_sdk.fs_store.indexer.functions.markdown import markdown_in_folder_fn
    from flow_sdk.fs_store.indexer.functions.mcp_server import (
        mcp_servers_in_file_fn,
        mcp_source_files_fn,
    )
    from flow_sdk.fs_store.indexer.functions.plugin import plugin_fn
    from flow_sdk.fs_store.indexer.functions.project_folder_walker import (
        project_folder_walker_fn,
    )
    from flow_sdk.fs_store.indexer.functions.repo_assets import repo_assets_fn
    from flow_sdk.fs_store.indexer.functions.workflow_run import workflow_run_fn
    from flow_sdk.fs_store.indexer.walkers.generic import layout_walker, walk_roots
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    # USER_HOME_FOLDER expanders.
    #
    # NOTE: there is deliberately NO USER_HOME_FOLDER -> REAL_PROJECT_CWD
    # expander. Project-cwd fanout was once implicit (any scan over USER_HOME
    # silently discovered + walked every Claude/Codex project tree), which made
    # ``?limit_types=N`` and ``scope_filter=None`` mean "walk the universe".
    # Project-cwd roots are contributed explicitly by the scope filter via
    # ``_resolve_scoped_roots``: callers that want all-projects pass
    # ``ScopeFilter`` materialised by ``get_all_scope_filter()``, narrower
    # callers pass a narrower filter, and the indexer only walks what the
    # caller actually asked for.
    # output_type annotations let scan() skip a function when no requested
    # type is reachable from its output (e.g. ``?type=skill`` skips every
    # function whose output is FOLDER / MARKDOWN / TASK / …).
    idx.add_function(RecordType.USER_HOME_FOLDER, claude_projects_fn, RecordType.PROJECT)
    idx.add_function(RecordType.USER_HOME_FOLDER, claude_md_in_claude_subdir_fn, RecordType.CLAUDE_MD)
    # Workflow run journals live at ~/.claude/projects/<slug>/<sid>/workflows/wf_*.json.
    idx.add_function(RecordType.USER_HOME_FOLDER, workflow_run_fn, RecordType.WORKFLOW_RUN)
    # Hook indexing is two-stage (recursive into-file walk):
    #   stage 1: <root> → CLAUDE_HOOK_SOURCE (one per settings.json-like file)
    #   stage 2: CLAUDE_HOOK_SOURCE → CLAUDE_HOOK (one per hook entry, with json_path)
    idx.add_function(RecordType.USER_HOME_FOLDER, claude_hook_files_fn, RecordType.CLAUDE_HOOK_SOURCE)
    idx.add_function(RecordType.USER_HOME_FOLDER, claude_hook_files_extras_fn, RecordType.CLAUDE_HOOK_SOURCE)
    # MCP servers are two-stage (source file → per-server, with json_path).
    idx.add_function(RecordType.USER_HOME_FOLDER, mcp_source_files_fn, RecordType.MCP_SERVER_SOURCE)
    # Plugins are a user-global single-file registry.
    idx.add_function(RecordType.USER_HOME_FOLDER, plugin_fn, RecordType.PLUGIN)
    # codex_projects_fn consolidates codex cwds into RecordType.PROJECT.
    # Annotating it with anything else makes the type-gating dispatcher skip it
    # for ``?type=project`` queries and silently drop every Codex-discovered
    # project.
    idx.add_function(RecordType.USER_HOME_FOLDER, codex_projects_fn, RecordType.PROJECT)
    idx.add_function(RecordType.USER_HOME_FOLDER, codex_sessions_fn, RecordType.CODEX_SESSION)
    idx.add_function(RecordType.USER_HOME_FOLDER, copilot_sessions_fn, RecordType.COPILOT_SESSION)

    # PROJECT (encoded ~/.claude/projects/<dir>) expanders
    idx.add_function(RecordType.PROJECT, claude_sessions_fn, RecordType.CLAUDE_SESSION)
    idx.add_function(RecordType.PROJECT, claude_memory_fn, RecordType.CLAUDE_MEMORY)

    # REAL_PROJECT_CWD (decoded cwd) expanders
    idx.add_function(RecordType.REAL_PROJECT_CWD, claude_md_in_project_root_fn, RecordType.CLAUDE_MD)
    idx.add_function(RecordType.REAL_PROJECT_CWD, project_folder_walker_fn, RecordType.FOLDER)
    idx.add_function(RecordType.REAL_PROJECT_CWD, claude_hook_files_fn, RecordType.CLAUDE_HOOK_SOURCE)
    idx.add_function(RecordType.REAL_PROJECT_CWD, mcp_source_files_fn, RecordType.MCP_SERVER_SOURCE)

    # SYSTEM_ROOT (flowpad_assistant) expanders
    idx.add_function(RecordType.SYSTEM_ROOT, project_folder_walker_fn, RecordType.FOLDER)

    # CWD_ROOT expanders. A cloned repo is scanned as a CWD_ROOT
    # (``_index_additional_dir``), so a journey a project SHIPS in
    # ``agentic-assets/journey/`` only becomes an entity — and can only
    # auto-launch — because ``repo_assets_fn`` below runs for this root too.
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

    # FOLDER (transient scaffold emitted by project_folder_walker_fn) expanders.
    # ``markdown_in_folder_fn`` stays bespoke: its typed-ancestor fence (skip
    # every ``.md`` under a family dir another type claims, and the skill doc
    # by name) is a cross-type rule the per-type ``Walk`` cannot state.
    idx.add_function(RecordType.FOLDER, markdown_in_folder_fn, RecordType.MARKDOWN)
    idx.add_function(RecordType.CWD_ROOT, claude_hook_files_fn, RecordType.CLAUDE_HOOK_SOURCE)

    # Declared walks. Every type carrying ``TypeInfo.walk`` is scanned by the
    # ONE generic walker, registered on each root its ``Walk`` names and
    # emitting the type itself — a new declared type enrolls with no edit here.
    # (claude_rules, command, plan, todo_file, subagent, skill, markdown's docs
    # walk, secret_origin, dynamic_workflow, spreadsheet, …)
    for type_name in SchemaRegistry.get_all_types():
        info = SchemaRegistry.get(type_name)
        if info is None or info.walk is None:
            continue
        walker = layout_walker(info)
        for root in walk_roots(info):
            idx.add_function(root, walker, RecordType(info.type_name))

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
_derived_types: list[RecordType] | None = None


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
    global _shared, _auto_scan_shared, _derived_types
    _shared = None
    _auto_scan_shared = None
    _derived_types = None
    try:
        from flow_sdk.fs_store.indexer.subprocess_scan import (  # noqa: PLC0415
            reset_child_availability,
        )

        reset_child_availability()
    except Exception:  # noqa: BLE001 — module may not be importable in a child
        pass
