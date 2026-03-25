"""API tests for FTS5 search submodule.

Tests:
- Entity.search() via FTS5
- fts_upsert / fts_search / fts_delete on the SQLite driver
- Search endpoint integration
"""

import os
import tempfile

import pytest
import pytest_asyncio

from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.db.drivers.sqlite.sqlite_driver import SQLiteDBDriver
from flow_sdk.db.drivers.db_driver import DBConfig
import flow_sdk.db.drivers.db_driver as db_driver_mod


@pytest_asyncio.fixture
async def fts_driver(tmp_path):
    """Create a fresh SQLite driver with FTS5 table."""
    db_path = str(tmp_path / "test_fts.db")
    cfg = DBConfig()
    cfg.database = db_path
    driver = SQLiteDBDriver(cfg)
    await driver.open()

    # Register Entity types so _schema_to_entity works
    from flow_sdk.schema.entity_factory import type_registry
    for t in ("test_entity", "shell", "note"):
        if type_registry.get(t) is None:
            type_registry.register(t, Entity)

    # Inject as the active driver
    old_instances = db_driver_mod._driver_instances.copy()
    db_driver_mod._driver_instances["sqlite"] = driver

    yield driver

    db_driver_mod._driver_instances = old_instances
    await driver.close()


async def _create_entity_with_content(driver, entity_id, entity_type, name, content, status=None):
    """Helper: create an Entity and upsert into FTS5."""
    entity = Entity(type=entity_type, id=entity_id, name=name, status=status)
    # Save to DB
    async with driver.session_factory() as session:
        schema = driver._entity_to_schema(entity)
        session.add(schema)
        await session.commit()
    # Upsert FTS
    from flow_sdk.db.drivers.sqlite.sqlite_driver import FtsEntry
    await driver.fts_upsert(FtsEntry(
        entity_id=entity_id,
        entity_type=entity_type,
        name=name,
        content=content,
    ))
    return entity


@pytest.mark.asyncio
async def test_fts5_search_basic(fts_driver):
    """Entity.search('hello') returns entities with matching indexed_content."""
    await _create_entity_with_content(
        fts_driver, "e1", "test_entity", "Greeting", "hello world from the test"
    )
    await _create_entity_with_content(
        fts_driver, "e2", "test_entity", "Farewell", "goodbye cruel world"
    )

    results = await Entity.search("hello")
    assert len(results) == 1
    assert results[0].id == "e1"


@pytest.mark.asyncio
async def test_fts5_search_by_name(fts_driver):
    """Entity.search('myrecord') matches entities by name field."""
    await _create_entity_with_content(
        fts_driver, "e1", "test_entity", "myrecord special", "some content"
    )
    await _create_entity_with_content(
        fts_driver, "e2", "test_entity", "other", "other content"
    )

    results = await Entity.search("myrecord")
    assert len(results) == 1
    assert results[0].id == "e1"


@pytest.mark.asyncio
async def test_fts5_search_by_type(fts_driver):
    """Entity.search('query', record_type='shell_session') filters by type."""
    await _create_entity_with_content(
        fts_driver, "e1", "shell", "Session A", "matching query text"
    )
    await _create_entity_with_content(
        fts_driver, "e2", "note", "Note B", "matching query text"
    )

    results = await Entity.search("query", record_type="shell")
    assert len(results) == 1
    assert results[0].id == "e1"


@pytest.mark.asyncio
async def test_fts5_search_empty_query(fts_driver):
    """Entity.search('') returns empty list (not all entities)."""
    await _create_entity_with_content(
        fts_driver, "e1", "test_entity", "Test", "content"
    )

    results = await Entity.search("")
    assert results == []


@pytest.mark.asyncio
async def test_fts5_search_limit(fts_driver):
    """Entity.search('query', limit=2) respects limit."""
    for i in range(5):
        await _create_entity_with_content(
            fts_driver, f"e{i}", "test_entity", f"Item {i}", f"common query term {i}"
        )

    results = await Entity.search("query", limit=2)
    assert len(results) == 2


@pytest.mark.asyncio
async def test_fts5_delete(fts_driver):
    """fts_delete removes entry from FTS index."""
    await _create_entity_with_content(
        fts_driver, "e1", "test_entity", "Deleteme", "unique searchable content"
    )

    results = await Entity.search("unique")
    assert len(results) == 1

    await fts_driver.fts_delete("e1")

    results = await Entity.search("unique")
    assert len(results) == 0


@pytest.mark.asyncio
async def test_fts5_upsert_updates_existing(fts_driver):
    """fts_upsert replaces existing FTS entry."""
    await _create_entity_with_content(
        fts_driver, "e1", "test_entity", "Original", "alpha beta"
    )

    results = await Entity.search("alpha")
    assert len(results) == 1

    # Update
    from flow_sdk.db.drivers.sqlite.sqlite_driver import FtsEntry
    await fts_driver.fts_upsert(FtsEntry(entity_id="e1", entity_type="test_entity", name="Updated", content="gamma delta"))

    results = await Entity.search("alpha")
    assert len(results) == 0
    results = await Entity.search("gamma")
    assert len(results) == 1


@pytest.mark.asyncio
async def test_indexed_content_not_in_api_response(fts_driver):
    """Entity no longer has indexed_content field."""
    assert "indexed_content" not in Entity.model_fields


@pytest.mark.asyncio
async def test_fts5_search_status_filter_in_sql(fts_driver):
    """status filter is applied in SQL before LIMIT, not in Python after.

    Regression test for Critical #5: if status were filtered after LIMIT,
    a limit=3 query against 5 archived + 2 active records would return 0 active
    results (3 archived fill the limit, active records never reached).
    """
    # 5 archived entities all matching "project"
    for i in range(5):
        await _create_entity_with_content(
            fts_driver, f"arch-{i}", "test_entity", f"Archived {i}", "project planning notes", status="archived"
        )
    # 2 active entities also matching "project"
    await _create_entity_with_content(
        fts_driver, "active-1", "test_entity", "Active One", "project planning notes", status="active"
    )
    await _create_entity_with_content(
        fts_driver, "active-2", "test_entity", "Active Two", "project planning notes", status="active"
    )

    # With limit=3 and status=active: SQL filters before LIMIT, so both active records are returned
    results = await Entity.search("project", limit=3, status="active")
    assert len(results) == 2
    assert all(getattr(r, "status", None) == "active" for r in results)

    # Without status filter: limit=3 returns 3 of the 7 matching (any status)
    results_no_filter = await Entity.search("project", limit=3)
    assert len(results_no_filter) == 3

    # status=archived returns up to limit from archived set
    results_archived = await Entity.search("project", limit=3, status="archived")
    assert len(results_archived) == 3
    assert all(getattr(r, "status", None) == "archived" for r in results_archived)
