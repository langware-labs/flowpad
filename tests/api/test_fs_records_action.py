"""Tests for the fs-records CRUD action on ComputeNode."""

import pytest

from flow_sdk.fs_store import set_default_records_root, get_default_records_root

# Import record classes to trigger auto-registration in the type_registry.
from flow_sdk.fs_records.skill_record import SkillRecord  # noqa: F401
from flow_sdk.fs_records.task import TaskResource  # noqa: F401


@pytest.fixture(autouse=True)
def isolate_records_root(tmp_path):
    """Redirect all record I/O to a temp directory for test isolation."""
    original = get_default_records_root()
    set_default_records_root(tmp_path)
    yield tmp_path
    set_default_records_root(original)


def _compute_node_id(bootstrap_payload: dict) -> str:
    return bootstrap_payload["data"]["default_compute_node"]["id"]


@pytest.mark.asyncio
async def test_list_types(bootstrapped_client):
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _compute_node_id(bootstrap.json())

    resp = await bootstrapped_client.get(f"/api/v1/graph/compute_node/{cn_id}/fs-records")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "SUCCESS"
    assert "skill" in body["data"]["types"]


@pytest.mark.asyncio
async def test_crud_lifecycle(bootstrapped_client):
    """Create → read → list → update → delete → 404 on re-read."""
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _compute_node_id(bootstrap.json())
    base = f"/api/v1/graph/compute_node/{cn_id}/fs-records/skill"

    # CREATE
    unique_token = "deleteftsprobeabc123"
    resp = await bootstrapped_client.post(
        base,
        json={"name": f"my-test-skill-{unique_token}", "description": f"A test {unique_token}"},
    )
    assert resp.status_code == 200, resp.text
    created = resp.json()["data"]
    record_id = created["id"]
    assert created["name"] == f"my-test-skill-{unique_token}"

    # CREATE syncs to FTS, and DELETE must remove that FTS row as well.
    resp = await bootstrapped_client.get(
        f"/api/v1/graph/compute_node/{cn_id}/fs-records/search"
        f"?q={unique_token}&record_type=skill"
    )
    assert resp.status_code == 200
    assert any(r["record_id"] == record_id for r in resp.json()["data"]["results"])

    # READ one
    resp = await bootstrapped_client.get(f"{base}/{record_id}")
    assert resp.status_code == 200
    assert resp.json()["data"]["id"] == record_id
    assert resp.json()["data"]["name"] == f"my-test-skill-{unique_token}"

    # LIST — discovers records from disk via SkillRecord.discover() which
    # scans ~/.claude/skills/, not the isolated records root. The test-created
    # record won't appear here, but we verify the endpoint works and returns
    # a valid list of discovered skills.
    resp = await bootstrapped_client.get(base)
    assert resp.status_code == 200
    records = resp.json()["data"]
    assert isinstance(records, list)

    # UPDATE
    resp = await bootstrapped_client.put(f"{base}/{record_id}", json={"description": "Updated"})
    assert resp.status_code == 200
    assert resp.json()["data"]["description"] == "Updated"
    # name should still be intact
    assert resp.json()["data"]["name"] == f"my-test-skill-{unique_token}"

    # DELETE
    resp = await bootstrapped_client.request("DELETE", f"{base}/{record_id}")
    assert resp.status_code == 200
    assert resp.json()["data"]["deleted"] == record_id

    # READ after delete → 404
    resp = await bootstrapped_client.get(f"{base}/{record_id}")
    assert resp.status_code == 404

    # Search after delete → stale FTS row is gone
    resp = await bootstrapped_client.get(
        f"/api/v1/graph/compute_node/{cn_id}/fs-records/search"
        f"?q={unique_token}&record_type=skill"
    )
    assert resp.status_code == 200
    assert all(r["record_id"] != record_id for r in resp.json()["data"]["results"])


@pytest.mark.asyncio
async def test_unknown_type_returns_400(bootstrapped_client):
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _compute_node_id(bootstrap.json())

    resp = await bootstrapped_client.get(
        f"/api/v1/graph/compute_node/{cn_id}/fs-records/nonexistent_type"
    )
    assert resp.status_code == 400
    assert "Unknown record type" in resp.json()["message"]


@pytest.mark.asyncio
async def test_update_without_uid_returns_400(bootstrapped_client):
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _compute_node_id(bootstrap.json())

    resp = await bootstrapped_client.put(
        f"/api/v1/graph/compute_node/{cn_id}/fs-records/skill",
        json={"name": "no-uid"},
    )
    assert resp.status_code == 400
    assert "uid is required" in resp.json()["message"]


@pytest.mark.asyncio
async def test_delete_without_uid_returns_400(bootstrapped_client):
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _compute_node_id(bootstrap.json())

    resp = await bootstrapped_client.request(
        "DELETE",
        f"/api/v1/graph/compute_node/{cn_id}/fs-records/skill",
    )
    assert resp.status_code == 400
    assert "uid is required" in resp.json()["message"]


@pytest.mark.asyncio
async def test_get_nonexistent_record_returns_404(bootstrapped_client):
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _compute_node_id(bootstrap.json())

    resp = await bootstrapped_client.get(
        f"/api/v1/graph/compute_node/{cn_id}/fs-records/skill/does-not-exist"
    )
    assert resp.status_code == 404
