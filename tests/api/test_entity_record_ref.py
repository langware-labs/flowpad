"""API tests for entity-record-ref submodule.

Tests Record.sync_to_db() creating/upserting Entities with record_data_ref,
SQL pushdown for record_data_ref queries, and vfs_record field removal.
"""

import uuid

import pytest
import pytest_asyncio

from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.builtin.workspace import Workspace
from flow_sdk.fs_store.fs_record import FSRecord as Record


@pytest_asyncio.fixture(autouse=True)
async def _isolate_record_state():
    """Clear DB rows for record types these tests seed, before AND after each
    test. Without this, sibling tests in the api suite leak rows that pollute
    record_data_ref queries (the conftest autouse fixtures only reset caches,
    not the shared session DB).
    """
    from flow_sdk.db import get_db_driver
    driver = get_db_driver()
    for t in ("markdown", "asset", "claude_project"):
        try:
            await driver.delete_entities_by_type(t)
        except Exception:
            pass
    yield
    for t in ("markdown", "asset", "claude_project"):
        try:
            await driver.delete_entities_by_type(t)
        except Exception:
            pass

# Use proper UUIDs so record.id == record.uuid (no UUID5 derivation needed)
_UUID_001 = str(uuid.uuid4())
_UUID_002 = str(uuid.uuid4())
_UUID_003 = str(uuid.uuid4())


@pytest.mark.asyncio
async def test_record_sync_to_db_creates_entity(bootstrapped_client):
    """record.index() creates Entity with correct name and status."""
    rec = Record(id=_UUID_001, type="workspace", name="Indexed Workspace", status="active")
    await rec.sync_to_db()

    entity = await Workspace.get_one({"id": _UUID_001})
    assert entity is not None
    assert entity.name == "Indexed Workspace"
    # record_data_ref has been removed — entity should not have this field
    assert not hasattr(entity, "record_data_ref")


@pytest.mark.asyncio
async def test_record_sync_to_db_upserts_entity(bootstrapped_client):
    """Second record.index() call updates existing Entity (no duplicate)."""
    rec = Record(id=_UUID_002, type="workspace", name="Original Name", status="new")
    await rec.sync_to_db()

    entity1 = await Workspace.get_one({"id": _UUID_002})
    assert entity1 is not None
    assert entity1.name == "Original Name"

    # Index again with updated fields
    rec2 = Record(id=_UUID_002, type="workspace", name="Updated Name", status="active")
    await rec2.sync_to_db()

    entity2 = await Workspace.get_one({"id": _UUID_002})
    assert entity2 is not None
    assert entity2.name == "Updated Name"
    # Same entity, not a duplicate
    assert entity2.id == entity1.id


@pytest.mark.asyncio
async def test_record_data_ref_field_removed(bootstrapped_client):
    """record_data_ref has been removed from Entity — it is not an API field or model field."""
    # Entity should not have record_data_ref in model_fields
    assert "record_data_ref" not in Entity.model_fields
    # Workspace (a subclass) should also not have it
    assert "record_data_ref" not in Workspace.model_fields


@pytest.mark.asyncio
async def test_vfs_record_field_removed(bootstrapped_client):
    """Entity model has no vfs_record or vfs_orphan fields."""
    assert "vfs_record" not in Entity.model_fields
    assert "vfs_orphan" not in Entity.model_fields


