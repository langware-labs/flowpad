"""CI regression test: indexer path set matches legacy walker path set per type.

Runs the full indexer once (module-scoped fixture) against the real user
home dir, and each legacy walker once per type, then asserts the path
sets match. On machines without ``~/.claude/`` content, every set is
empty and the comparison trivially passes.

For most types the relation is exact set equality. For ``claude_hook``
the relation is subset (legacy ⊆ indexer): one settings.json source file
yields N hook records at index stage, and legacy's `source_file` set
only counts files that actually produced records. The indexer scan
emits every candidate source file it finds.

This test is the stop-gap that lets us retire legacy walkers once the
indexer is wired into production — any future change that causes drift
will fail here instead of silently diverging in production.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Callable

import pytest

from flow_sdk.fs_records.claude.claude_session import ClaudeSessionRecord
from flow_sdk.fs_records.claude.claude_plan import ClaudePlanRecord
from flow_sdk.fs_records.claude.claude_claude_md import ClaudeMdFsRecord
from flow_sdk.fs_records.claude.claude_rules import ClaudeRulesRecord
from flow_sdk.fs_records.spec_record import SpecRecord
from flow_sdk.fs_records.claude.claude_project import (
    ClaudeProjectFsRecord, _TEMP_PATH_PREFIXES,
)
from flow_sdk.fs_records.skill_record import SkillRecord
from flow_sdk.fs_records.agent_record import AgentRecord
from flow_sdk.fs_records.workflow_record import WorkflowRecord
from flow_sdk.fs_records.claude.claude_command import ClaudeCommandFsRecord
from flow_sdk.fs_records.claude.claude_memory import ClaudeMemoryRecord
from flow_sdk.fs_records.markdown_record import MarkdownRecord
from flow_sdk.fs_records.claude.claude_hook_record import ClaudeHookRecord

from flow_sdk.fs_store.indexer import FSIndexer, IndexerOptions, default_roots
from flow_sdk.fs_store.indexer.functions.claude_projects import claude_projects_fn
from flow_sdk.fs_store.indexer.functions.claude_sessions import claude_sessions_fn
from flow_sdk.fs_store.indexer.functions.real_project_cwd import real_project_cwd_fn
from flow_sdk.fs_store.indexer.functions.claude_plan import claude_plan_fn
from flow_sdk.fs_store.indexer.functions.claude_md import (
    claude_md_in_claude_subdir_fn, claude_md_in_project_root_fn,
)
from flow_sdk.fs_store.indexer.functions.claude_rules import claude_rules_fn
from flow_sdk.fs_store.indexer.functions.spec import spec_project_fn
from flow_sdk.fs_store.indexer.functions.skill import skill_fn
from flow_sdk.fs_store.indexer.functions.agent import agent_fn
from flow_sdk.fs_store.indexer.functions.workflow import workflow_fn
from flow_sdk.fs_store.indexer.functions.claude_command import command_fn
from flow_sdk.fs_store.indexer.functions.claude_memory import claude_memory_fn
from flow_sdk.fs_store.indexer.functions.markdown import (
    markdown_flat_fn, markdown_with_docs_subdirs_fn,
)
from flow_sdk.fs_store.indexer.functions.task import task_fn
from flow_sdk.fs_store.indexer.functions.claude_hook import (
    claude_hook_fn, claude_hook_extras_fn,
)
from flow_sdk.fs_store.record_types import RecordType


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------


def _legacy_paths_from_records(records) -> set[str]:
    """Extract resolved source-file paths from a list of Record instances."""
    out: set[str] = set()
    for rec in records:
        ar = object.__getattribute__(rec, "_asset_ref")
        if ar is not None and ar._path is not None:
            out.add(str(Path(ar.path).resolve()))
    return out


def _is_valid_project_dir(name: str) -> bool:
    real = "/" + name.lstrip("-").replace("-", "/")
    return not real.startswith(_TEMP_PATH_PREFIXES)


def _build_indexer() -> FSIndexer:
    idx = FSIndexer(state_dir=Path("/tmp/indexer_state"), roots=default_roots())

    idx.add_function(RecordType.USER_HOME_FOLDER, claude_projects_fn)
    idx.add_function(RecordType.USER_HOME_FOLDER, real_project_cwd_fn)
    idx.add_function(RecordType.USER_HOME_FOLDER, claude_plan_fn)
    idx.add_function(RecordType.USER_HOME_FOLDER, claude_md_in_claude_subdir_fn)
    idx.add_function(RecordType.USER_HOME_FOLDER, claude_rules_fn)
    idx.add_function(RecordType.USER_HOME_FOLDER, skill_fn)
    idx.add_function(RecordType.USER_HOME_FOLDER, agent_fn)
    idx.add_function(RecordType.USER_HOME_FOLDER, workflow_fn)
    idx.add_function(RecordType.USER_HOME_FOLDER, command_fn)
    idx.add_function(RecordType.USER_HOME_FOLDER, markdown_flat_fn)
    idx.add_function(RecordType.USER_HOME_FOLDER, claude_hook_fn)
    idx.add_function(RecordType.USER_HOME_FOLDER, claude_hook_extras_fn)

    idx.add_function(RecordType.PROJECT, claude_sessions_fn)
    idx.add_function(RecordType.PROJECT, claude_memory_fn)

    idx.add_function(RecordType.REAL_PROJECT_CWD, claude_plan_fn)
    idx.add_function(RecordType.REAL_PROJECT_CWD, claude_md_in_project_root_fn)
    idx.add_function(RecordType.REAL_PROJECT_CWD, claude_rules_fn)
    idx.add_function(RecordType.REAL_PROJECT_CWD, spec_project_fn)
    idx.add_function(RecordType.REAL_PROJECT_CWD, skill_fn)
    idx.add_function(RecordType.REAL_PROJECT_CWD, agent_fn)
    idx.add_function(RecordType.REAL_PROJECT_CWD, workflow_fn)
    idx.add_function(RecordType.REAL_PROJECT_CWD, markdown_with_docs_subdirs_fn)
    idx.add_function(RecordType.REAL_PROJECT_CWD, task_fn)
    idx.add_function(RecordType.REAL_PROJECT_CWD, claude_hook_fn)

    idx.add_function(RecordType.SYSTEM_ROOT, skill_fn)
    idx.add_function(RecordType.SYSTEM_ROOT, agent_fn)
    idx.add_function(RecordType.SYSTEM_ROOT, markdown_flat_fn)

    idx.add_function(RecordType.CWD_ROOT, claude_plan_fn)
    idx.add_function(RecordType.CWD_ROOT, claude_rules_fn)
    idx.add_function(RecordType.CWD_ROOT, skill_fn)
    idx.add_function(RecordType.CWD_ROOT, agent_fn)
    idx.add_function(RecordType.CWD_ROOT, workflow_fn)
    idx.add_function(RecordType.CWD_ROOT, command_fn)
    idx.add_function(RecordType.CWD_ROOT, markdown_with_docs_subdirs_fn)
    idx.add_function(RecordType.CWD_ROOT, claude_hook_fn)

    return idx


# --------------------------------------------------------------------------
# Legacy path-set extractors (one per type)
# --------------------------------------------------------------------------


def _legacy_claude_session() -> set[str]:
    return {str(p.resolve()) for p in ClaudeSessionRecord.discover_paths_iter()}


def _legacy_project() -> set[str]:
    return {str(Path(r.path).resolve()) for r in ClaudeProjectFsRecord._external_source_iter()}


def _legacy_plan() -> set[str]:
    return _legacy_paths_from_records(list(ClaudePlanRecord._external_source_iter()))


def _legacy_claude_md() -> set[str]:
    return _legacy_paths_from_records(list(ClaudeMdFsRecord._external_source_iter()))


def _legacy_claude_rules() -> set[str]:
    return _legacy_paths_from_records(list(ClaudeRulesRecord._external_source_iter()))


def _legacy_spec() -> set[str]:
    return _legacy_paths_from_records(list(SpecRecord._external_source_iter()))


def _legacy_skill() -> set[str]:
    return _legacy_paths_from_records(list(SkillRecord.discover_iter()))


def _legacy_agent() -> set[str]:
    return _legacy_paths_from_records(list(AgentRecord._external_source_iter()))


def _legacy_workflow() -> set[str]:
    return _legacy_paths_from_records(list(WorkflowRecord._external_source_iter()))


def _legacy_command() -> set[str]:
    return {
        str(Path(r.source_file).resolve())
        for r in ClaudeCommandFsRecord.discover_iter()
        if r.source_file
    }


def _legacy_claude_memory() -> set[str]:
    return _legacy_paths_from_records(list(ClaudeMemoryRecord._external_source_iter()))


def _legacy_markdown() -> set[str]:
    return _legacy_paths_from_records(list(MarkdownRecord._external_source_iter()))


def _legacy_claude_hook() -> set[str]:
    return {
        str(Path(r.source_file).resolve())
        for r in ClaudeHookRecord.discover()
        if r.source_file
    }


def _legacy_task() -> set[str]:
    """Replicate notification_scanner walk — TaskResource has no _external_source_iter."""
    from flow_sdk.fs_records._claude_projects import iter_claude_project_paths
    out: set[str] = set()
    for project_root in iter_claude_project_paths():
        tasks_dir = project_root / "tasks"
        if not tasks_dir.is_dir():
            continue
        for task_dir in sorted(tasks_dir.iterdir()):
            if not task_dir.is_dir() or task_dir.name == "spec":
                continue
            manifest = task_dir / "manifest.json"
            if manifest.is_file():
                out.add(str(manifest.resolve()))
    return out


# --------------------------------------------------------------------------
# Type map — (name, RecordType, legacy extractor, match mode, apply filter)
# --------------------------------------------------------------------------

TYPE_SPECS: list[tuple[str, RecordType, Callable[[], set[str]], str]] = [
    ("claude_session",  RecordType.CLAUDE_SESSION,   _legacy_claude_session,  "exact"),
    ("project",         RecordType.PROJECT,          _legacy_project,         "exact"),
    ("plan",            RecordType.PLAN,             _legacy_plan,            "exact"),
    ("claude_md",       RecordType.CLAUDE_MD,        _legacy_claude_md,       "exact"),
    ("claude_rules",    RecordType.CLAUDE_RULES,     _legacy_claude_rules,    "exact"),
    ("spec",            RecordType.SPEC,             _legacy_spec,            "exact"),
    ("skill",           RecordType.SKILL,            _legacy_skill,           "exact"),
    ("agent",           RecordType.AGENT,            _legacy_agent,           "exact"),
    ("workflow",        RecordType.WORKFLOW,         _legacy_workflow,        "exact"),
    ("command",         RecordType.COMMAND,          _legacy_command,         "exact"),
    ("claude_memory",   RecordType.CLAUDE_MEMORY,    _legacy_claude_memory,   "exact"),
    ("markdown",        RecordType.MARKDOWN,         _legacy_markdown,        "exact"),
    ("claude_hook",     RecordType.CLAUDE_HOOK,      _legacy_claude_hook,     "subset"),
    ("task",            RecordType.TASK,             _legacy_task,            "exact"),
]


# --------------------------------------------------------------------------
# Fixture — run the indexer once, bucket by record_type
# --------------------------------------------------------------------------


@pytest.fixture(scope="module")
def indexer_paths() -> dict[RecordType, set[str]]:
    """Run the full indexer once and return {record_type: set[resolved_path]}."""
    async def _run() -> dict[RecordType, set[str]]:
        idx = _build_indexer()
        nodes = await idx.scan(IndexerOptions(verbose=False))
        out: dict[RecordType, set[str]] = {}
        for n in nodes:
            if n.record_type is None:
                continue
            out.setdefault(n.record_type, set()).add(str(Path(n.path).resolve()))
        return out
    return asyncio.run(_run())


# --------------------------------------------------------------------------
# Parametrized test — one case per record type
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "name,record_type,legacy_fn,match_mode",
    TYPE_SPECS,
    ids=[spec[0] for spec in TYPE_SPECS],
)
def test_indexer_parity_per_type(
    indexer_paths: dict[RecordType, set[str]],
    name: str,
    record_type: RecordType,
    legacy_fn: Callable[[], set[str]],
    match_mode: str,
) -> None:
    legacy_set = legacy_fn()
    indexer_set = indexer_paths.get(record_type, set())

    if match_mode == "exact":
        missing = legacy_set - indexer_set
        extra = indexer_set - legacy_set
        assert not missing, (
            f"{name}: legacy found {len(missing)} path(s) indexer missed "
            f"(sample: {sorted(missing)[:3]})"
        )
        assert not extra, (
            f"{name}: indexer emitted {len(extra)} path(s) legacy doesn't see "
            f"(sample: {sorted(extra)[:3]})"
        )
    elif match_mode == "subset":
        missing = legacy_set - indexer_set
        assert not missing, (
            f"{name}: legacy found {len(missing)} path(s) indexer missed "
            f"(sample: {sorted(missing)[:3]})"
        )
    else:
        raise AssertionError(f"unknown match_mode={match_mode!r}")


def test_indexer_scope_correctness(
    indexer_paths: dict[RecordType, set[str]],
) -> None:
    """Every emitted node for a scope-requiring type has a valid scope value."""
    # Re-run indexer (this test needs FSRef objects, not just paths — the
    # fixture collapses to paths). Cheap on top of the main fixture since
    # the disk cache is warm.
    async def _run() -> list:
        idx = _build_indexer()
        return await idx.scan(IndexerOptions(verbose=False))
    nodes = asyncio.run(_run())

    scope_requiring = {
        RecordType.SKILL, RecordType.AGENT, RecordType.WORKFLOW,
        RecordType.CLAUDE_MD, RecordType.CLAUDE_RULES, RecordType.COMMAND,
    }
    valid_scopes = {"user", "project", "system"}
    for n in nodes:
        if n.record_type in scope_requiring:
            assert n.scope in valid_scopes, (
                f"{n.record_type} record at {n.path} has invalid scope {n.scope!r}"
            )
