"""Unit tests for 6-column FTS5 schema: upsert, search, BM25 ranking."""

from __future__ import annotations

import json

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.ext.asyncio import async_sessionmaker, AsyncSession

from flow_sdk.db.drivers.sqlite.connection import Base
from flow_sdk.db.drivers.sqlite.sqlite_driver import SQLiteDBDriver, SearchCalibration


async def _insert_entity_and_fts(session_factory, eid, etype, name="", title="", description="", content=""):
    """Helper: insert both entity row and FTS row."""
    async with session_factory() as session:
        data_json = json.dumps({"name": name})
        await session.execute(
            text("INSERT INTO entities (id, type, created_date, updated_date, data) VALUES (:id, :type, '2024-01-01', '2024-01-01', :data)"),
            {"id": eid, "type": etype, "data": data_json},
        )
        await session.execute(
            text("INSERT INTO entities_fts (entity_id, type, name, title, description, content) VALUES (:id, :type, :name, :title, :desc, :content)"),
            {"id": eid, "type": etype, "name": name, "title": title, "desc": description, "content": content},
        )
        await session.commit()


@pytest_asyncio.fixture
async def fts_driver(tmp_path):
    """Temp-file driver with 6-column FTS5 schema."""
    db_file = str(tmp_path / "test_fts.db")
    engine = create_async_engine(f"sqlite+aiosqlite:///{db_file}", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.execute(text("""
            CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
                entity_id, type, name, title, description, content,
                tokenize='porter unicode61'
            )
        """))

    session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    from flow_sdk.db.drivers.db_driver import DBConfig
    from flow_sdk.schema.entity_factory import type_registry

    cfg = DBConfig()
    driver = SQLiteDBDriver.__new__(SQLiteDBDriver)
    driver.registry = type_registry
    driver.config = cfg
    driver.session_factory = session_factory
    driver.engine = engine

    yield driver, session_factory

    await engine.dispose()


@pytest.mark.asyncio
async def test_fts_six_columns_searchable(fts_driver):
    """Each of the 6 columns is independently searchable."""
    driver, session_factory = fts_driver
    await _insert_entity_and_fts(
        session_factory, "col-001", "fts_test_type",
        name="uniquename", title="uniquetitle", description="uniquedescription", content="uniquecontent",
    )

    for term, label in [("uniquename", "name"), ("uniquetitle", "title"), ("uniquedescription", "description"), ("uniquecontent", "content")]:
        hits = await driver.fts_search(term, limit=5)
        assert any(getattr(e, "id", None) == "col-001" for e in hits), f"{label} column not searchable"


@pytest.mark.asyncio
async def test_fts_title_description_on_entity(fts_driver):
    """Searched entities carry _fts_title and _fts_description attributes."""
    driver, session_factory = fts_driver
    await _insert_entity_and_fts(
        session_factory, "col-002", "fts_test_type",
        name="somename", title="SpecialTitle999", description="SpecialDesc999", content="bodytext",
    )
    results = await driver.fts_search("SpecialTitle999", limit=5)
    hit = next((e for e in results if getattr(e, "id", None) == "col-002"), None)
    assert hit is not None
    assert getattr(hit, "_fts_title", None) == "SpecialTitle999"
    assert getattr(hit, "_fts_description", None) == "SpecialDesc999"


@pytest.mark.asyncio
async def test_fts_bm25_title_ranks_above_content(fts_driver):
    """A match in title ranks above a match in content-only for the same query term."""
    driver, session_factory = fts_driver
    term = "rankterm777"
    # Entity A: term in title (weight=8)
    await _insert_entity_and_fts(session_factory, "rank-title", "fts_test_type", name="alpha", title=term, content="unrelated")
    # Entity B: term in content only (weight=1)
    await _insert_entity_and_fts(session_factory, "rank-content", "fts_test_type", name="beta", content=term)

    results = await driver.fts_search(term, limit=10)
    ids = [getattr(e, "id", None) for e in results]
    assert "rank-title" in ids, "title match not found"
    assert "rank-content" in ids, "content match not found"
    assert ids.index("rank-title") < ids.index("rank-content"), (
        "Title match should rank above content-only match"
    )


@pytest.mark.asyncio
async def test_fts_upsert_via_driver(fts_driver):
    """fts_upsert inserts 6-column rows correctly (requires pre-existing entity)."""
    driver, session_factory = fts_driver
    # Insert entity first (JOIN required by fts_search)
    async with session_factory() as session:
        await session.execute(
            text("INSERT INTO entities (id, type, created_date, updated_date, data) VALUES ('upsert-001', 'bookmark', '2024-01-01', '2024-01-01', '{}')"),
        )
        await session.commit()

    from flow_sdk.db.drivers.sqlite.sqlite_driver import FtsEntry
    await driver.fts_upsert(FtsEntry(
        entity_id="upsert-001",
        entity_type="bookmark",
        name="bookmarkname",
        title="BookmarkTitle",
        description="BookmarkDesc",
        content="BookmarkContent",
    ))
    results = await driver.fts_search("BookmarkTitle", limit=5)
    hit = next((e for e in results if getattr(e, "id", None) == "upsert-001"), None)
    assert hit is not None
    assert getattr(hit, "_fts_title", None) == "BookmarkTitle"
    assert getattr(hit, "_fts_description", None) == "BookmarkDesc"
