"""Basic end-to-end test for the FSIndexer skeleton — DFS traversal.

Spec for the minimal indexer: register one function per RecordType, call
scan(), walk emits typed FSRef nodes in depth-first order. No DB writes,
no sentinels, no parsing — just path enumeration + dispatch.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import (
    FSIndexer,
    IndexerOptions,
)
from flow_sdk.fs_store.indexer.builtin import build_default_indexer
from flow_sdk.fs_store.indexer.functions.claude_projects import (
    claude_projects_fn,
)
from flow_sdk.fs_store.indexer.functions.claude_sessions import (
    claude_sessions_fn,
)
from flow_sdk.fs_store.record_types import RecordType


@pytest.mark.asyncio
async def test_basic_indexer_dfs_discovers_projects_and_sessions(
    tmp_path: Path,
) -> None:
    # Arrange — a fake user HOME containing .claude/projects/<encoded>/<sid>.jsonl
    home: Path = tmp_path / "home"
    projects_dir: Path = home / ".claude" / "projects"
    projects_dir.mkdir(parents=True)

    project_a: Path = projects_dir / "-Users-alice-repo-a"
    project_b: Path = projects_dir / "-Users-alice-repo-b"
    project_a.mkdir()
    project_b.mkdir()

    sess_a1: Path = project_a / "sess-1.jsonl"
    sess_a2: Path = project_a / "sess-2.jsonl"
    sess_b1: Path = project_b / "sess-3.jsonl"
    sess_a1.write_text("{}\n")
    sess_a2.write_text("{}\n")
    sess_b1.write_text("{}\n")

    # Act
    indexer: FSIndexer = FSIndexer(
        roots=[FSRef(home, record_type=RecordType.USER_HOME_FOLDER)],
    )
    indexer.add_function(RecordType.USER_HOME_FOLDER, claude_projects_fn)
    indexer.add_function(RecordType.PROJECT, claude_sessions_fn)

    nodes: list[FSRef] = await indexer.scan(IndexerOptions(verbose=True))

    # Assert — three levels reached, correct counts per type
    by_type: dict[RecordType, list[FSRef]] = {}
    for n in nodes:
        if n.record_type is not None:
            by_type.setdefault(n.record_type, []).append(n)

    assert len(by_type[RecordType.USER_HOME_FOLDER]) == 1
    assert len(by_type[RecordType.PROJECT]) == 2
    assert len(by_type[RecordType.CLAUDE_SESSION]) == 3

    # Assert — parent links preserved
    session_parents: set[str] = {
        n._parent.path
        for n in by_type[RecordType.CLAUDE_SESSION]
        if n._parent is not None
    }
    assert session_parents == {str(project_a.resolve()), str(project_b.resolve())}

    # Assert — DFS visit order.
    # With sorted iteration inside each function, the exact order is:
    #   home → project_a → sess_a1 → sess_a2 → project_b → sess_b1
    paths_in_order: list[str] = [n.path for n in nodes]
    assert paths_in_order == [
        str(home.resolve()),
        str(project_a.resolve()),
        str(sess_a1.resolve()),
        str(sess_a2.resolve()),
        str(project_b.resolve()),
        str(sess_b1.resolve()),
    ]


def test_skill_type_closure_keeps_only_required_scaffolds() -> None:
    closure = build_default_indexer()._compute_needed_output_types(
        (RecordType.SKILL,)
    )

    assert closure is not None
    assert RecordType.SKILL in closure
    assert RecordType.FOLDER in closure
    assert RecordType.CLAUDE_SESSION not in closure
    assert RecordType.CODEX_SESSION not in closure
    assert RecordType.COPILOT_SESSION not in closure


@pytest.mark.asyncio
async def test_multi_output_registration_runs_only_for_intersecting_types(
    tmp_path: Path,
) -> None:
    root = FSRef(tmp_path, record_type=RecordType.CWD_ROOT)
    calls = {"repo": 0, "session": 0}

    def repo_walker(nodes, _opts):
        calls["repo"] += 1
        return []

    def session_walker(nodes, _opts):
        calls["session"] += 1
        return []

    indexer = FSIndexer(roots=[root])
    indexer.add_function(
        RecordType.CWD_ROOT,
        repo_walker,
        {RecordType.SPEC, RecordType.TASK},
    )
    indexer.add_function(
        RecordType.CWD_ROOT,
        session_walker,
        RecordType.CLAUDE_SESSION,
    )

    await indexer.scan(IndexerOptions(types=[RecordType.SPEC]))
    assert calls == {"repo": 1, "session": 0}

    calls.update(repo=0, session=0)
    await indexer.scan(IndexerOptions(types=[RecordType.SKILL]))
    assert calls == {"repo": 0, "session": 0}


def test_unknown_output_registration_disables_type_pruning(tmp_path: Path) -> None:
    indexer = FSIndexer(
        roots=[FSRef(tmp_path, record_type=RecordType.CWD_ROOT)]
    )
    indexer.add_function(RecordType.CWD_ROOT, lambda nodes, opts: [])

    assert indexer._compute_needed_output_types((RecordType.SKILL,)) is None
