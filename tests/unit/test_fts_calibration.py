"""Unit tests for FTS5 search calibration — cross-param matrix with latency checks."""

import itertools
import time

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from flow_sdk.db.drivers.sqlite.connection import Base
from flow_sdk.db.drivers.sqlite.sqlite_driver import SearchCalibration, SQLiteDBDriver

MATRIX = list(
    itertools.product(
        [None, [0, 0, 10, 1], [0, 0, 5, 2]],  # col_weights
        [None, 0.005, 0.05],  # recency_boost
        [None, {"skill": -2.0}, {"skill": -2.0, "claude_session": -1.0}],  # type_scores
    )
)


@pytest_asyncio.fixture
async def driver_with_data():
    """Create in-memory SQLite driver and populate with test FTS data."""
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # Create FTS5 virtual table matching the one created in SQLiteDriver.open()
        await conn.execute(
            text("""
            CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
                entity_id, type, name, title, description, content,
                tokenize='porter unicode61'
            )
        """)
        )

    session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    # Insert test entities and FTS rows
    async with session_factory() as session:
        from datetime import UTC, datetime

        now = datetime.now(UTC).isoformat()
        old_date = "2024-01-01T00:00:00+00:00"

        # Insert into entities table — schema has: id, type, namespace, key, uname,
        # type_uname, created_by, created_date, updated_by, updated_date,
        # created_through, updated_through, schema_version, data, record_data_ref.
        # Name is stored in 'data' JSON column.
        test_entities = [
            ("ent_1", "skill", "test skill one", "This is test content for skill entity", now),
            ("ent_2", "skill", "test skill two", "Another test document with skill content", old_date),
            ("ent_3", "bookmark", "test bookmark", "A test bookmark with some content here", now),
            ("ent_4", "claude_session", "test session", "Test claude session content", old_date),
            ("ent_5", "note", "test note", "Some test note content", now),
        ]
        for eid, etype, ename, content, updated in test_entities:
            import json

            data_json = json.dumps({"name": ename})
            await session.execute(
                text("""
                INSERT INTO entities (id, type, created_date, updated_date, data)
                VALUES (:id, :type, :created, :updated, :data)
            """),
                {
                    "id": eid,
                    "type": etype,
                    "created": updated,
                    "updated": updated,
                    "data": data_json,
                },
            )
            await session.execute(
                text("""
                INSERT INTO entities_fts (entity_id, type, name, title, description, content)
                VALUES (:id, :type, :name, '', '', :content)
            """),
                {"id": eid, "type": etype, "name": ename, "content": content},
            )
        await session.commit()

    from flow_sdk.db.drivers.db_driver import DBConfig

    cfg = DBConfig()
    driver = SQLiteDBDriver.__new__(SQLiteDBDriver)
    # Manually initialize the minimal state needed for fts_search:
    # - registry (from DBDriver.__init__ via super)
    from flow_sdk.schema.entity_factory import type_registry

    driver.registry = type_registry
    driver.config = cfg
    driver.session_factory = session_factory
    driver.engine = engine
    yield driver
    await engine.dispose()


@pytest.mark.parametrize("col_weights,recency_boost,type_scores", MATRIX)
@pytest.mark.asyncio
async def test_calibration_matrix(driver_with_data, col_weights, recency_boost, type_scores):
    cal = SearchCalibration(
        col_weights=col_weights,
        recency_boost=recency_boost,
        type_scores=type_scores,
    )
    start = time.perf_counter()
    results = await driver_with_data.fts_search("test", limit=10, calibration=cal)
    elapsed_ms = (time.perf_counter() - start) * 1000

    # Correctness: results returned, no SQL errors
    assert isinstance(results, list)

    # Performance: sanity check < 500ms
    print(
        f"\n[col_weights={col_weights}, recency_boost={recency_boost}, type_scores={type_scores}] "
        f"→ {len(results)} results in {elapsed_ms:.1f}ms"
    )
    assert elapsed_ms < 500, f"Query too slow: {elapsed_ms:.1f}ms"


@pytest.mark.asyncio
async def test_no_calibration_uses_simple_rank(driver_with_data):
    """Without calibration, query should use simple 'rank' ordering."""
    results = await driver_with_data.fts_search("test", limit=10, calibration=None)
    assert isinstance(results, list)
    assert len(results) > 0


@pytest.mark.asyncio
async def test_calibration_col_weights_returns_results(driver_with_data):
    """Col weights calibration should return results without error."""
    cal = SearchCalibration(col_weights=[0, 0, 10, 1])
    results = await driver_with_data.fts_search("test", limit=10, calibration=cal)
    assert isinstance(results, list)


@pytest.mark.asyncio
async def test_calibration_type_scores_returns_results(driver_with_data):
    """Type score calibration should return results without error."""
    cal = SearchCalibration(type_scores={"skill": -2.0})
    results = await driver_with_data.fts_search("test", limit=10, calibration=cal)
    assert isinstance(results, list)


@pytest.mark.asyncio
async def test_calibration_recency_boost_returns_results(driver_with_data):
    """Recency boost calibration should return results without error."""
    cal = SearchCalibration(recency_boost=0.01)
    results = await driver_with_data.fts_search("test", limit=10, calibration=cal)
    assert isinstance(results, list)


@pytest.mark.asyncio
async def test_empty_calibration_equals_no_calibration(driver_with_data):
    """Empty SearchCalibration should behave the same as no calibration."""
    results_none = await driver_with_data.fts_search("test", limit=10, calibration=None)
    results_empty = await driver_with_data.fts_search("test", limit=10, calibration=SearchCalibration())
    # Both should return same count
    assert len(results_none) == len(results_empty)
