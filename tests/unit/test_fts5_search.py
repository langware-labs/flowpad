"""Unit tests for FTS5 search submodule.

Verifies:
- flow_sdk/fs_store/search/ directory is deleted
- Entity does NOT have an indexed_content field (removed in favour of Record.search_content)
- Record.sync_to_db() full cycle: correct entity type + FTS search finds result
"""

import uuid
from pathlib import Path

import pytest
import pytest_asyncio

import flow_sdk.db.drivers.db_driver as db_driver_mod
from flow_sdk.db.drivers.db_driver import DBConfig
from flow_sdk.db.drivers.sqlite.sqlite_driver import SQLiteDBDriver


@pytest_asyncio.fixture
async def fts_unit_driver(tmp_path):
    """Isolated SQLite driver for Record.sync_to_db() unit tests.

    Patches both _driver_instances and Entity._db so that all Entity/Record
    calls (including LazyDBDriver-cached paths) hit the test database.
    """
    db_path = str(tmp_path / "unit_fts.db")
    cfg = DBConfig()
    cfg.database = db_path
    driver = SQLiteDBDriver(cfg)
    await driver.open()

    from flow_sdk.core.entity.entity_model import Entity
    from flow_sdk.schema.entity_factory import type_registry

    for t in ("unit_skill", "unit_bookmark"):
        if type_registry.get(t) is None:
            type_registry.register(t, Entity)

    old_instances = db_driver_mod._driver_instances.copy()
    db_driver_mod._driver_instances["sqlite"] = driver

    # LazyDBDriver replaces Entity._db with the concrete driver on first access.
    # Patch it now so all Entity / Record calls use the test DB.
    old_db = Entity.__dict__.get("_db")
    Entity._db = driver

    yield driver

    # Restore
    db_driver_mod._driver_instances = old_instances
    if old_db is None:
        if "_db" in Entity.__dict__:
            delattr(Entity, "_db")
    else:
        Entity._db = old_db
    await driver.close()


def test_search_dir_deleted():
    """Verify flow_sdk/fs_store/search/ directory does not exist."""
    search_dir = Path(__file__).resolve().parents[2] / "flow_sdk" / "fs_store" / "search"
    assert not search_dir.exists(), f"search/ directory still exists at {search_dir}"


def test_entity_indexed_content_field_removed():
    """Entity no longer has indexed_content field (removed in favour of Record.search_content)."""
    from flow_sdk.core.entity.entity_model import Entity

    assert "indexed_content" not in Entity.model_fields


# ---------------------------------------------------------------------------
# Full-cycle tests: Record.sync_to_db() → entity type → fts_search finds record
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_record_sync_to_db_stores_correct_entity_type(fts_unit_driver):
    """Record.sync_to_db() stores entity with the record's own type, not 'entity'.

    This is the regression test for the bug where entities were saved with
    type='entity' (the fallback base class default) instead of the record's
    actual type (e.g. 'skill', 'bookmark').
    """
    from sqlalchemy import select

    from flow_sdk.db.drivers.sqlite.connection import EntitySchema
    from flow_sdk.fs_store.record import Record

    class UnitSkillRecord(Record):
        _record_type = "unit_skill"

        @property
        def search_content(self):
            return getattr(self, "description", None)

    rec = UnitSkillRecord(id=str(uuid.uuid4()), name="My Skill", description="unique_skill_token_abc123")
    await rec.sync_to_db()

    # Check directly via DB (bypassing Entity.get_one's type filter)
    async with fts_unit_driver.session_factory() as session:
        result = await session.execute(select(EntitySchema).where(EntitySchema.id == rec.id))
        schema = result.scalar_one_or_none()
    assert schema is not None, "Entity was not saved to DB after Record.sync_to_db()"
    assert schema.type == "unit_skill", (
        f"Expected entity.type='unit_skill' but got '{schema.type}'. "
        "Record.sync_to_db() must pass type=record_type to create_kwargs so the "
        "entity is not stored with the fallback type 'entity'."
    )


@pytest.mark.asyncio
async def test_record_sync_to_db_then_fts_search_returns_result(fts_unit_driver):
    """Record.sync_to_db() → FTS5 upsert → Entity.search() returns the record.

    This is the regression test for the bug where fts_search silently returned
    [] because _schema_to_entity failed with 'str object has no attribute tzinfo'
    (raw SQL dates come back as strings, not datetime objects).
    """
    from flow_sdk.core.entity.entity_model import Entity
    from flow_sdk.fs_store.record import Record

    class UnitBookmarkRecord(Record):
        _record_type = "unit_bookmark"

        @property
        def search_content(self):
            return getattr(self, "body", None)

    rec = UnitBookmarkRecord(id=str(uuid.uuid4()), name="Test Bookmark", body="searchable_magic_word_zyx987")
    await rec.sync_to_db()

    results = await Entity.search("searchable_magic_word_zyx987")
    assert len(results) >= 1, (
        "Entity.search() returned no results after Record.sync_to_db(). "
        "Check _schema_to_entity date coercion and Record.sync_to_db() entity type handling."
    )
    assert any(r.id == rec.id for r in results)


@pytest.mark.asyncio
async def test_record_sync_to_db_none_content_not_indexed(fts_unit_driver):
    """Records with no searchable content are NOT added to the FTS index.

    With the 6-column schema, a record with a non-empty name IS indexed (name column).
    A record with no name, no search_title, no search_description, and no search_content
    should NOT be indexed.
    """
    from sqlalchemy import select

    from flow_sdk.core.entity.entity_model import Entity
    from flow_sdk.db.drivers.sqlite.connection import EntitySchema
    from flow_sdk.fs_store.record import Record

    class NoContentRecord(Record):
        _record_type = "unit_skill"
        # Does NOT override any search_* properties — all return None

    # Record with no name (name defaults to "") and no search_* overrides
    rec = NoContentRecord(id=str(uuid.uuid4()))
    await rec.sync_to_db()

    # Entity should still be created (for Entity DB)
    async with fts_unit_driver.session_factory() as session:
        result = await session.execute(select(EntitySchema).where(EntitySchema.id == rec.id))
        schema = result.scalar_one_or_none()
    assert schema is not None, "Entity was not saved to DB after Record.sync_to_db()"

    # FTS should not contain this entity (no indexable content)
    results = await Entity.search("noindex")
    assert all(r.id != rec.id for r in results)

    # A record WITH a name IS indexed (name column is now part of FTS)
    rec2 = NoContentRecord(id=str(uuid.uuid4()), name="uniqueterm999xyzq")
    await rec2.sync_to_db()
    results2 = await Entity.search("uniqueterm999xyzq")
    assert any(r.id == rec2.id for r in results2), "Record with name should be findable via name column"
