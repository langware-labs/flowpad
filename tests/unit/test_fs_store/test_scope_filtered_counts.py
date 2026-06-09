"""Regression guard for ScopeFilter narrowing on count / delete driver methods.

Validates that the SQL fragment built by `_scope_sql_clause` matches the
in-memory predicate defined by `apply_scope_filter` (server/search_filters.py),
so the scanner page's scoped index-status and DELETE buttons produce the
same row set the assets page sees.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from sqlalchemy import text

from flow_sdk.db import get_db_driver
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import FSIndexer, IndexerOptions
from flow_sdk.fs_store.indexer.functions.markdown import markdown_flat_fn
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.server.search_filters import ScopeFilter


async def _seed_scoped_markdowns(tmp_path: Path) -> tuple[str, str]:
    """Index 4 markdown rows: 2 user-scope, 2 project-scope split across two
    project ids. Returns the two project ids for assertions."""
    user_root = tmp_path / "user_home"
    (user_root / ".claude" / "docs").mkdir(parents=True)
    (user_root / ".claude" / "docs" / "u1.md").write_text("# u1\n")
    (user_root / ".claude" / "docs" / "u2.md").write_text("# u2\n")

    proj_a_root = tmp_path / "projA"
    (proj_a_root / ".claude" / "docs").mkdir(parents=True)
    (proj_a_root / ".claude" / "docs" / "a1.md").write_text("# a1\n")

    proj_b_root = tmp_path / "projB"
    (proj_b_root / ".claude" / "docs").mkdir(parents=True)
    (proj_b_root / ".claude" / "docs" / "b1.md").write_text("# b1\n")

    driver = get_db_driver()
    await driver.delete_entities_by_type(str(RecordType.MARKDOWN))

    idx = FSIndexer()
    idx.add_root(FSRef(user_root, record_type=RecordType.USER_HOME_FOLDER, scope="user"))
    idx.add_root(FSRef(proj_a_root, record_type=RecordType.USER_HOME_FOLDER, scope="project", project_id="proj-A"))
    idx.add_root(FSRef(proj_b_root, record_type=RecordType.USER_HOME_FOLDER, scope="project", project_id="proj-B"))
    idx.add_function(RecordType.USER_HOME_FOLDER, markdown_flat_fn)
    await idx.index(IndexerOptions(verbose=False, types=[RecordType.MARKDOWN]))

    return "proj-A", "proj-B"


@pytest.mark.asyncio
async def test_count_entities_unscoped_returns_all(tmp_path: Path) -> None:
    await _seed_scoped_markdowns(tmp_path)
    driver = get_db_driver()
    assert await driver.count_entities_by_type("markdown") == 4


@pytest.mark.asyncio
async def test_count_entities_user_only_returns_user_rows(tmp_path: Path) -> None:
    await _seed_scoped_markdowns(tmp_path)
    driver = get_db_driver()
    sf = ScopeFilter(user=True, projects=())
    assert await driver.count_entities_by_type("markdown", scope=sf) == 2


@pytest.mark.asyncio
async def test_count_entities_one_project_returns_one_row(tmp_path: Path) -> None:
    pid_a, _ = await _seed_scoped_markdowns(tmp_path)
    driver = get_db_driver()
    sf = ScopeFilter(user=False, projects=(pid_a,))
    assert await driver.count_entities_by_type("markdown", scope=sf) == 1


@pytest.mark.asyncio
async def test_count_entities_matches_record_project_alias(tmp_path: Path) -> None:
    pid_a, _ = await _seed_scoped_markdowns(tmp_path)
    driver = get_db_driver()
    sf = ScopeFilter(user=False, projects=("entity-proj-A",), record_projects=(pid_a,))
    assert await driver.count_entities_by_type("markdown", scope=sf) == 1


@pytest.mark.asyncio
async def test_count_entities_drops_empty_scope_for_scoped_record_types(tmp_path: Path) -> None:
    await _seed_scoped_markdowns(tmp_path)
    driver = get_db_driver()
    async with driver._session_ctx() as session:
        await session.execute(
            text("INSERT INTO entities (id, type, data) VALUES (:id, :type, :data)"),
            {
                "id": "broken-empty-scope-markdown",
                "type": "markdown",
                "data": json.dumps({"id": "broken-empty-scope-markdown", "type": "markdown"}),
            },
        )
    sf = ScopeFilter(user=True, projects=())
    assert await driver.count_entities_by_type("markdown", scope=sf) == 2


@pytest.mark.asyncio
async def test_count_entities_both_returns_user_plus_project(tmp_path: Path) -> None:
    pid_a, _ = await _seed_scoped_markdowns(tmp_path)
    driver = get_db_driver()
    sf = ScopeFilter(user=True, projects=(pid_a,))
    assert await driver.count_entities_by_type("markdown", scope=sf) == 3


@pytest.mark.asyncio
async def test_delete_entities_scoped_leaves_other_scope_untouched(tmp_path: Path) -> None:
    pid_a, pid_b = await _seed_scoped_markdowns(tmp_path)
    driver = get_db_driver()

    deleted = await driver.delete_entities_by_type(
        "markdown", scope=ScopeFilter(user=False, projects=(pid_a,))
    )
    assert deleted == 1

    # Other scopes intact: user(2) + projB(1) = 3 remaining
    assert await driver.count_entities_by_type("markdown") == 3
    async with driver._session_ctx() as session:
        row = (await session.execute(
            text(
                "SELECT COUNT(*) FROM entities WHERE type='markdown' "
                "AND json_extract(data, '$.project_id') = :p"
            ),
            {"p": pid_b},
        )).fetchone()
    assert row[0] == 1, "projB row must survive a projA-scoped delete"
