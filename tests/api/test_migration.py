"""API tests for migration-path submodule.

Tests for:
- _migrate_vfs_record_to_data_ref(): DB migration of vfs_record -> record_data_ref
"""

import json
import uuid

import pytest
import pytest_asyncio

from sqlalchemy import text
from flow_sdk.db.drivers.sqlite.sqlite_driver import (
    _migrate_vfs_record_to_data_ref,
    _parse_vfs_uri_to_ref,
    SafeJSONEncoder,
)


@pytest_asyncio.fixture
async def db_engine():
    """Create a temporary in-memory SQLite DB with entities table."""
    from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker

    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)

    async with engine.begin() as conn:
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS entities (
                id VARCHAR(36) PRIMARY KEY,
                type VARCHAR(50) NOT NULL,
                namespace VARCHAR(255),
                key VARCHAR(255),
                uname VARCHAR(255),
                type_uname VARCHAR(512),
                created_by VARCHAR(50),
                created_date DATETIME,
                updated_by VARCHAR(50),
                updated_date DATETIME,
                created_through VARCHAR(255),
                updated_through VARCHAR(255),
                schema_version VARCHAR(50),
                data TEXT
            )
        """))

    yield engine

    await engine.dispose()


@pytest.mark.asyncio
async def test_vfs_record_db_migration(db_engine):
    """Entity with vfs_record in data JSON blob is migrated to record_data_ref on DB init."""
    entity_id = str(uuid.uuid4())
    vfs_uri = "vfs://compute_node-@local/records/shell_session/shell_session-@abc123"
    data_blob = json.dumps({
        "name": "Test Entity",
        "vfs_record": vfs_uri,
        "status": "active",
    })

    async with db_engine.begin() as conn:
        await conn.execute(text(
            "INSERT INTO entities (id, type, data) VALUES (:id, :type, :data)"
        ), {"id": entity_id, "type": "shell_session", "data": data_blob})

    # Run the migration
    async with db_engine.begin() as conn:
        await _migrate_vfs_record_to_data_ref(conn)

    # Verify
    async with db_engine.begin() as conn:
        result = await conn.execute(text(
            "SELECT data, record_data_ref FROM entities WHERE id = :id"
        ), {"id": entity_id})
        row = result.fetchone()

    assert row is not None
    data = json.loads(row[0])

    # vfs_record removed from data blob
    assert "vfs_record" not in data
    # Domain fields preserved
    assert data["name"] == "Test Entity"
    assert data["status"] == "active"
    # record_data_ref column populated
    assert row[1] == "shell_session/abc123"


@pytest.mark.asyncio
async def test_vfs_orphan_db_migration(db_engine):
    """Entity with vfs_orphan=True gets vfs_orphan removed from data blob."""
    entity_id = str(uuid.uuid4())
    data_blob = json.dumps({
        "name": "Orphan Entity",
        "vfs_orphan": True,
        "status": "orphan",
    })

    async with db_engine.begin() as conn:
        await conn.execute(text(
            "INSERT INTO entities (id, type, data) VALUES (:id, :type, :data)"
        ), {"id": entity_id, "type": "note", "data": data_blob})

    # Run the migration
    async with db_engine.begin() as conn:
        await _migrate_vfs_record_to_data_ref(conn)

    # Verify
    async with db_engine.begin() as conn:
        result = await conn.execute(text(
            "SELECT data FROM entities WHERE id = :id"
        ), {"id": entity_id})
        row = result.fetchone()

    assert row is not None
    data = json.loads(row[0])
    assert "vfs_orphan" not in data
    assert data["name"] == "Orphan Entity"
    assert data["status"] == "orphan"


@pytest.mark.asyncio
async def test_vfs_record_and_orphan_together(db_engine):
    """Entity with both vfs_record and vfs_orphan gets both cleaned up."""
    entity_id = str(uuid.uuid4())
    vfs_uri = "vfs://compute_node-@local/records/note/note-@n1"
    data_blob = json.dumps({
        "name": "Both Fields",
        "vfs_record": vfs_uri,
        "vfs_orphan": True,
    })

    async with db_engine.begin() as conn:
        await conn.execute(text(
            "INSERT INTO entities (id, type, data) VALUES (:id, :type, :data)"
        ), {"id": entity_id, "type": "note", "data": data_blob})

    async with db_engine.begin() as conn:
        await _migrate_vfs_record_to_data_ref(conn)

    async with db_engine.begin() as conn:
        result = await conn.execute(text(
            "SELECT data, record_data_ref FROM entities WHERE id = :id"
        ), {"id": entity_id})
        row = result.fetchone()

    data = json.loads(row[0])
    assert "vfs_record" not in data
    assert "vfs_orphan" not in data
    assert row[1] == "note/n1"


@pytest.mark.asyncio
async def test_malformed_vfs_uri_logs_warning(db_engine):
    """Malformed VFS URI is handled gracefully -- entity data cleaned but no ref set."""
    entity_id = str(uuid.uuid4())
    data_blob = json.dumps({
        "name": "Bad URI",
        "vfs_record": "garbage-no-at-sign",
    })

    async with db_engine.begin() as conn:
        await conn.execute(text(
            "INSERT INTO entities (id, type, data) VALUES (:id, :type, :data)"
        ), {"id": entity_id, "type": "test", "data": data_blob})

    async with db_engine.begin() as conn:
        await _migrate_vfs_record_to_data_ref(conn)

    async with db_engine.begin() as conn:
        result = await conn.execute(text(
            "SELECT data, record_data_ref FROM entities WHERE id = :id"
        ), {"id": entity_id})
        row = result.fetchone()

    data = json.loads(row[0])
    assert "vfs_record" not in data
    # record_data_ref should be NULL since URI was malformed
    assert row[1] is None


@pytest.mark.asyncio
async def test_migration_idempotent(db_engine):
    """Running the migration twice does not cause errors or data corruption."""
    entity_id = str(uuid.uuid4())
    vfs_uri = "vfs://compute_node-@local/shell_session-@s1"
    data_blob = json.dumps({
        "name": "Idempotent",
        "vfs_record": vfs_uri,
    })

    async with db_engine.begin() as conn:
        await conn.execute(text(
            "INSERT INTO entities (id, type, data) VALUES (:id, :type, :data)"
        ), {"id": entity_id, "type": "shell_session", "data": data_blob})

    # Run migration twice
    async with db_engine.begin() as conn:
        await _migrate_vfs_record_to_data_ref(conn)

    async with db_engine.begin() as conn:
        await _migrate_vfs_record_to_data_ref(conn)

    # Verify still correct
    async with db_engine.begin() as conn:
        result = await conn.execute(text(
            "SELECT data, record_data_ref FROM entities WHERE id = :id"
        ), {"id": entity_id})
        row = result.fetchone()

    data = json.loads(row[0])
    assert "vfs_record" not in data
    assert row[1] == "shell_session/s1"
