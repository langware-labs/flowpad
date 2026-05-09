"""Basic end-to-end tests for FSIndexer.index() — discover → parse → DB write.

Uses a temp HOME directory (not the user's real ~/.claude/) so the assertions
are deterministic. Relies on the session-scoped ``initialize_test_db`` fixture
in ``tests/conftest.py`` for isolated SQLite storage.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.db import get_db_driver
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import FSIndexer, IndexerOptions
from flow_sdk.fs_store.indexer.functions.claude_projects import claude_projects_fn
from flow_sdk.fs_store.indexer.functions.claude_sessions import claude_sessions_fn
from flow_sdk.fs_store.record_types import RecordType


def _write_fake_session(
    home: Path, encoded_project: str, session_id: str
) -> Path:
    project_dir = home / ".claude" / "projects" / encoded_project
    project_dir.mkdir(parents=True, exist_ok=True)
    jsonl = project_dir / f"{session_id}.jsonl"
    cwd = "/" + encoded_project.lstrip("-").replace("-", "/")
    jsonl.write_text(
        f'{{"sessionId":"{session_id}","cwd":"{cwd}","type":"user"}}\n',
        encoding="utf-8",
    )
    return jsonl


def _build_indexer_for_sessions(home: Path, state_dir: Path | None = None) -> FSIndexer:
    idx = FSIndexer(
        roots=[
            FSRef(home, record_type=RecordType.USER_HOME_FOLDER, scope="user"),
        ],
    )
    idx.add_function(RecordType.USER_HOME_FOLDER, claude_projects_fn)
    idx.add_function(RecordType.PROJECT, claude_sessions_fn)
    return idx


@pytest.fixture
async def clean_db():
    """Delete CLAUDE_SESSION + PROJECT rows before/after each test."""
    driver = get_db_driver()
    for rt in (RecordType.CLAUDE_SESSION, RecordType.PROJECT):
        await driver.delete_entities_by_type(str(rt))
    yield driver
    for rt in (RecordType.CLAUDE_SESSION, RecordType.PROJECT):
        await driver.delete_entities_by_type(str(rt))


@pytest.mark.asyncio
async def test_index_writes_session_and_project_records(
    tmp_path: Path, clean_db,
) -> None:
    """Indexer emits both PROJECT (intermediate) and CLAUDE_SESSION refs when both have from_fsref."""
    home = tmp_path / "home"
    _write_fake_session(home, "-Users-alice-repo-a", "abc123")
    _write_fake_session(home, "-Users-alice-repo-a", "def456")
    _write_fake_session(home, "-Users-alice-repo-b", "ghi789")

    idx = _build_indexer_for_sessions(home, tmp_path / "idx_state")
    result = await idx.index(IndexerOptions(verbose=False))

    # 2 projects + 3 sessions = 5 records total
    assert result.total_indexed == 5, (
        f"expected 5 indexed (3 sessions + 2 projects), got {result.total_indexed}"
    )
    assert result.total_errors == 0
    assert result.per_type[RecordType.CLAUDE_SESSION].indexed == 3
    assert result.per_type[RecordType.PROJECT].indexed == 2

    assert await clean_db.count_entities_by_type(
        str(RecordType.CLAUDE_SESSION)
    ) == 3
    assert await clean_db.count_entities_by_type(str(RecordType.PROJECT)) == 2


@pytest.mark.asyncio
async def test_index_filters_by_types(
    tmp_path: Path, clean_db,
) -> None:
    """With types=[CLAUDE_SESSION], only CLAUDE_SESSION records are written."""
    home = tmp_path / "home"
    _write_fake_session(home, "-Users-alice-repo", "only-sess")

    idx = _build_indexer_for_sessions(home, tmp_path / "idx_state")
    result = await idx.index(
        IndexerOptions(verbose=False, types=[RecordType.CLAUDE_SESSION])
    )

    assert RecordType.CLAUDE_SESSION in result.per_type
    assert RecordType.PROJECT not in result.per_type
    assert result.total_indexed == 1

    assert await clean_db.count_entities_by_type(
        str(RecordType.CLAUDE_SESSION)
    ) == 1
    assert await clean_db.count_entities_by_type(str(RecordType.PROJECT)) == 0


@pytest.mark.asyncio
async def test_index_result_shape(
    tmp_path: Path, clean_db,
) -> None:
    home = tmp_path / "home"
    _write_fake_session(home, "-Users-alice-repo", "s1")

    idx = _build_indexer_for_sessions(home, tmp_path / "idx_state")
    result = await idx.index(
        IndexerOptions(verbose=False, types=[RecordType.CLAUDE_SESSION])
    )

    assert result.total_indexed == 1
    assert result.total_errors == 0
    assert result.duration_ms > 0
    pt = result.per_type[RecordType.CLAUDE_SESSION]
    assert pt.type == RecordType.CLAUDE_SESSION
    assert pt.indexed == 1
    assert pt.errors == 0
    assert pt.duration_ms >= 0


@pytest.mark.asyncio
async def test_index_empty_home_produces_empty_result(
    tmp_path: Path, clean_db,
) -> None:
    """No .claude/ under HOME → no records found, no errors, empty result."""
    home = tmp_path / "empty_home"
    home.mkdir()

    idx = _build_indexer_for_sessions(home, tmp_path / "idx_state")
    result = await idx.index(IndexerOptions(verbose=False))

    assert result.total_indexed == 0
    assert result.total_errors == 0
    assert result.per_type == {}
