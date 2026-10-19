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
from flow_sdk.fs_store.indexer.walkers.generic import walker_for
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.server.search_filters import ScopeFilter


async def _seed_scoped_markdowns(tmp_path: Path) -> tuple[str, str]:
    """Index 4 markdown rows: 2 user-scope, 2 project-scope split across two
    project ids. Returns the two project ids for assertions."""
    user_root = tmp_path / "user_home"
    (user_root / "docs").mkdir(parents=True)
    (user_root / "docs" / "u1.md").write_text("# u1\n")
    (user_root / "docs" / "u2.md").write_text("# u2\n")

    proj_a_root = tmp_path / "projA"
    (proj_a_root / "docs").mkdir(parents=True)
    (proj_a_root / "docs" / "a1.md").write_text("# a1\n")

    proj_b_root = tmp_path / "projB"
    (proj_b_root / "docs").mkdir(parents=True)
    (proj_b_root / "docs" / "b1.md").write_text("# b1\n")

    driver = get_db_driver()
    await driver.delete_entities_by_type(str(RecordType.MARKDOWN))

    idx = FSIndexer()
    idx.add_root(FSRef(user_root, record_type=RecordType.USER_HOME_FOLDER, scope="user"))
    idx.add_root(FSRef(proj_a_root, record_type=RecordType.USER_HOME_FOLDER, scope="project", project_id="proj-A"))
    idx.add_root(FSRef(proj_b_root, record_type=RecordType.USER_HOME_FOLDER, scope="project", project_id="proj-B"))
    idx.add_function(RecordType.USER_HOME_FOLDER, walker_for("markdown"))
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


async def _insert_system_markdown(driver, *, row_id: str, project_id: str) -> None:
    """Insert a single `scope='system'` markdown row carrying a project id —
    mirrors how SYSTEM_ROOT rows (Flowpad Assistant) are stamped."""
    async with driver._session_ctx() as session:
        await session.execute(
            text("INSERT INTO entities (id, type, data) VALUES (:id, :type, :data)"),
            {
                "id": row_id,
                "type": "markdown",
                "data": json.dumps(
                    {"id": row_id, "type": "markdown", "scope": "system", "project_id": project_id}
                ),
            },
        )


@pytest.mark.asyncio
async def test_count_system_visible_only_when_its_project_selected(tmp_path: Path) -> None:
    """A `scope='system'` row counts iff its project is explicitly in scope —
    not under user-only, not under a different project, but yes when selected."""
    pid_a, _ = await _seed_scoped_markdowns(tmp_path)
    driver = get_db_driver()
    await _insert_system_markdown(driver, row_id="sys-md-1", project_id="sys-P")

    # Selected → visible (the 1 system row).
    sf_sys = ScopeFilter(user=False, projects=("sys-P",))
    assert await driver.count_entities_by_type("markdown", scope=sf_sys) == 1

    # A different project → system row excluded (only projA's own row).
    sf_a = ScopeFilter(user=False, projects=(pid_a,))
    assert await driver.count_entities_by_type("markdown", scope=sf_a) == 1

    # User-only → system row excluded (the 2 user rows).
    sf_user = ScopeFilter(user=True, projects=())
    assert await driver.count_entities_by_type("markdown", scope=sf_user) == 2

    # Unscoped → everything, including the system row (4 seeded + 1 system).
    assert await driver.count_entities_by_type("markdown") == 5


@pytest.mark.asyncio
async def test_count_system_matches_record_project_alias(tmp_path: Path) -> None:
    """System rows resolve through `record_projects` the same as project rows."""
    await _seed_scoped_markdowns(tmp_path)
    driver = get_db_driver()
    await _insert_system_markdown(driver, row_id="sys-md-2", project_id="sys-P")
    sf = ScopeFilter(user=False, projects=("entity-sys-P",), record_projects=("sys-P",))
    assert await driver.count_entities_by_type("markdown", scope=sf) == 1


@pytest.mark.asyncio
async def test_asset_stats_per_type_matches_count(tmp_path: Path) -> None:
    """get_asset_stats reports the same per-type live count as the driver, and
    narrows by ScopeFilter identically (the UI counter source of truth)."""
    from flow_sdk.fs_store.indexer import index_log

    pid_a, _ = await _seed_scoped_markdowns(tmp_path)

    unscoped = await index_log.get_asset_stats()
    assert unscoped.per_type["markdown"] == 4
    assert unscoped.total == sum(unscoped.per_type.values())

    proj = await index_log.get_asset_stats(scope=ScopeFilter(user=False, projects=(pid_a,)))
    assert proj.per_type["markdown"] == 1

    both = await index_log.get_asset_stats(scope=ScopeFilter(user=True, projects=(pid_a,)))
    assert both.per_type["markdown"] == 3


@pytest.mark.asyncio
async def test_asset_stats_count_increments_on_create(tmp_path: Path) -> None:
    """Creating an asset row bumps the live count get_asset_stats returns."""
    from flow_sdk.fs_store.indexer import index_log

    await _seed_scoped_markdowns(tmp_path)
    driver = get_db_driver()
    before = (await index_log.get_asset_stats()).per_type["markdown"]

    await _insert_system_markdown(driver, row_id="new-md", project_id="proj-A")

    after = (await index_log.get_asset_stats()).per_type["markdown"]
    assert after == before + 1


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
