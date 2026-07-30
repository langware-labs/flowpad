"""Generic single-file-reindex helper + per-type wrappers.

Used by the dock loader's 404 self-heal path
(``flow_sdk/server/routes/graph.py::_try_self_heal_missing_entity``).
When a chip click for a typeid whose row hasn't been indexed yet comes
in with ``?hint_path=<file>``, the registry in graph.py dispatches to the
matching wrapper here; the wrapper computes the indexer's expected root
from the hint path's layout and runs a scoped, ``force=True`` walk for
the single record type. Force bypasses skip-fresh so a freshly created
file is picked up on first call.

The pattern was originally inlined as ``_index_single_plan`` in
``plan_handler.py``; this module generalizes it. ``_index_single_plan``
is re-exported by ``plan_handler.py`` for its ``resolve_plan`` fallback.
"""

from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import FSIndexer, IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


async def _index_single_file(
    root: Path,
    indexer_fn,
    record_type: RecordType,
    root_record_type: RecordType = RecordType.USER_HOME_FOLDER,
) -> None:
    """Run a single-type, force=True walk from ``root`` using ``indexer_fn``.

    The wrapper functions below each compute the right ``root`` from
    the hint path's filesystem layout — different ``*_fn`` functions
    expect different parent depths.
    """
    idx = FSIndexer(roots=[FSRef(root, record_type=root_record_type)])
    idx.add_function(root_record_type, indexer_fn)
    await idx.index(
        IndexerOptions(types=[record_type], force=True, verbose=False)
    )


async def _index_single_plan(plan_md_path: Path) -> None:
    """``~/.claude/plans/<name>.md`` → root = ``~`` (parents[2])."""
    from flow_sdk.fs_store.indexer.functions.claude_plan import claude_plan_fn
    await _index_single_file(
        plan_md_path.parents[2], claude_plan_fn, RecordType.PLAN,
    )


async def _index_single_markdown(md_path: Path) -> None:
    """``<root>/docs/**/*.md`` → root = the parent of the ``docs`` segment.

    Wires the DOCS family mount used by ``markdown_flat_fn`` (was
    ``.claude/docs`` before markdown became ``AssetClass.DOCS``). The root is
    found by walking UP to the ``docs`` segment rather than a fixed
    ``parents[N]``: ``markdown_flat_fn`` rglobs, so the file may be nested any
    number of levels below ``docs/`` — a fixed index silently picks the wrong
    root for ``docs/sub/a.md``.

    Project-scoped markdown (under a project's tree, picked up by
    ``markdown_in_folder_fn`` via the folder walker) needs a different
    walker setup and is not handled here — those rows are populated by
    the regular project walks.
    """
    from flow_sdk.fs_store.indexer.functions.markdown import markdown_flat_fn
    from flow_sdk.fs_store.placement import DOCS_FAMILY

    root = next((p.parent for p in md_path.parents if p.name == DOCS_FAMILY), None)
    if root is None:
        return
    await _index_single_file(root, markdown_flat_fn, RecordType.MARKDOWN)


async def _index_single_skill(skill_path: Path) -> None:
    """``<root>/.claude/skills/<name>/SKILL.md`` (or the SKILL DIR itself).

    Hint may be either the SKILL.md file or the containing skill folder.
    Normalize to the skill DIR, then root = ``<root>`` (parents[2] of the
    skill dir, i.e. parents[3] of the file).
    """
    from flow_sdk.fs_store.indexer.functions.skill import skill_fn
    skill_dir = skill_path.parent if skill_path.is_file() else skill_path
    await _index_single_file(
        skill_dir.parents[2], skill_fn, RecordType.SKILL,
    )


async def _index_single_claude_md(md_path: Path) -> None:
    """``<root>/CLAUDE.md`` (project root) or ``<root>/.claude/CLAUDE.md``.

    Default to the project-root layout (file's parent is the root). The
    ``.claude/`` variant has the same indexer entry-point because
    ``claude_md_in_project_root_fn`` searches both ``<root>/CLAUDE.md``
    and ``<root>/.claude/CLAUDE.md`` under the same root.
    """
    from flow_sdk.fs_store.indexer.functions.claude_md import (
        claude_md_in_project_root_fn,
    )
    root = md_path.parent
    # If the file lives under .claude/, the real project root is one up.
    if root.name == ".claude":
        root = root.parent
    await _index_single_file(
        root, claude_md_in_project_root_fn, RecordType.CLAUDE_MD,
    )


async def _index_single_claude_session(jsonl_path: Path) -> None:
    """``~/.claude/projects/<encoded>/<sessionId>.jsonl`` → root = the encoded
    project dir (the PROJECT node ``claude_sessions_fn`` expands)."""
    from flow_sdk.fs_store.indexer.functions.claude_sessions import claude_sessions_fn
    await _index_single_file(
        jsonl_path.parent, claude_sessions_fn, RecordType.CLAUDE_SESSION,
        root_record_type=RecordType.PROJECT,
    )


async def _index_single_claude_memory(memory_path: Path) -> None:
    """``~/.claude/projects/<encoded>/memory/<name>.md`` → root = ``~`` (parents[4])."""
    from flow_sdk.fs_store.indexer.functions.claude_memory import claude_memory_fn
    await _index_single_file(
        memory_path.parents[4], claude_memory_fn, RecordType.CLAUDE_MEMORY,
    )


async def _index_single_claude_rules(rules_path: Path) -> None:
    """``<root>/.claude/rules/<name>.md`` → root = ``<root>`` (parents[2])."""
    from flow_sdk.fs_store.indexer.functions.claude_rules import claude_rules_fn
    await _index_single_file(
        rules_path.parents[2], claude_rules_fn, RecordType.CLAUDE_RULES,
    )


async def _index_single_command(command_path: Path) -> None:
    """``<root>/.claude/commands/<name>.md`` → root = ``<root>`` (parents[2])."""
    from flow_sdk.fs_store.indexer.functions.claude_command import command_fn
    await _index_single_file(
        command_path.parents[2], command_fn, RecordType.COMMAND,
    )
