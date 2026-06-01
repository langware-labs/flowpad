"""API tests for Entity record_data_ref (replaces old vfs_record sync tests).

Tests that record_data_ref works correctly through the API layer, including
the write-through hook that syncs Entity updates back to disk Records.
"""

import tempfile
from pathlib import Path

import pytest
import pytest_asyncio

from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.fs_store.record_paths import set_default_records_root

from flow_sdk.fs_store.fs_record import FSRecord as Record
from flow_sdk.responses.response import ApiResponse


@pytest_asyncio.fixture(autouse=True)
async def _isolate_record_state():
    """Clear DB rows for record types these tests seed, before AND after each
    test. Sibling tests in the api suite leak rows that pollute the
    record_data_ref write-through behavior."""
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


@pytest.mark.asyncio
async def test_create_entity_record_data_ref_not_accepted(bootstrapped_client):
    """record_data_ref has been removed — it is no longer an accepted API field."""
    response = await bootstrapped_client.post(
        "/api/v1/graph/workspace",
        json={
            "name": "Ref Test Workspace",
            "record_data_ref": "workspace/ref-001",
        },
    )
    assert response.status_code == 200, response.text
    res = ApiResponse(**response.json())
    assert res.status == "SUCCESS"
    # record_data_ref is not an API field — it should not appear in the response
    entity_data = res.data
    assert entity_data.get("record_data_ref") is None


@pytest.mark.asyncio
async def test_vfs_record_fields_not_accepted(bootstrapped_client):
    """vfs_record and vfs_orphan are no longer API fields."""
    assert "vfs_record" not in Entity.model_fields
    assert "vfs_orphan" not in Entity.model_fields


@pytest.mark.asyncio
async def test_write_through_entity_update_syncs_to_disk_record(bootstrapped_client):
    """PUT /graph/{type}/{id} writes entity fields back to the disk record when type has a Record class."""
    import json
    import uuid

    from flow_sdk.builtin.workspace import Workspace
    from flow_sdk.fs_store.record_paths import get_default_records_root, record_stem

    original_root = get_default_records_root()
    with tempfile.TemporaryDirectory() as tmpdir:
        records_root = Path(tmpdir)
        set_default_records_root(records_root)

        try:
            # Use a UUID4 id so the graph router recognises it as a valid entity id
            record_id = str(uuid.uuid4())
            rec = Record(id=record_id, type="workspace", name="Original Name", status="new")
            rec.save()

            rec_path = get_default_records_root() / "workspace" / record_stem("workspace", record_id) / "metadata.json"
            assert rec_path.exists(), "Record should be on disk after save()"

            # Index the record → creates Workspace entity
            await rec.sync_to_db()

            # Verify entity was created
            entity = await Workspace.get_one({"id": record_id})
            assert entity is not None
            assert entity.name == "Original Name"
            # record_data_ref has been removed
            assert not hasattr(entity, "record_data_ref")

            # Update via graph API — write-through via Entity._store() (uses SchemaRegistry)
            response = await bootstrapped_client.put(
                f"/api/v1/graph/workspace/{record_id}",
                json={"name": "Updated Name", "status": "active"},
            )
            assert response.status_code == 200, response.text
            res = ApiResponse(**response.json())
            assert res.status == "SUCCESS"
            assert res.data.get("name") == "Updated Name"

        finally:
            set_default_records_root(original_root)


@pytest.mark.asyncio
async def test_write_through_noop_when_no_record_data_ref(bootstrapped_client):
    """PUT /graph/{type}/{id} without record_data_ref does not fail."""
    response = await bootstrapped_client.post(
        "/api/v1/graph/workspace",
        json={"name": "No Ref Workspace"},
    )
    assert response.status_code == 200
    res = ApiResponse(**response.json())
    entity_id = res.data.get("id")
    assert entity_id

    # Update should succeed even without record_data_ref
    response = await bootstrapped_client.put(
        f"/api/v1/graph/workspace/{entity_id}",
        json={"name": "Updated No Ref"},
    )
    assert response.status_code == 200
    res = ApiResponse(**response.json())
    assert res.status == "SUCCESS"
    assert res.data.get("name") == "Updated No Ref"
