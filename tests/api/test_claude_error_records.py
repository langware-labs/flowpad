"""API tests for claude_error records via the fs-records action."""

import uuid

import pytest


def _compute_node_id(bootstrap_payload: dict) -> str:
    return bootstrap_payload["data"]["default_compute_node"]["id"]


# ─── Type discovery ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_fs_records_list_type_includes_claude_error(bootstrapped_client):
    """The claude_error type should appear in the types list."""
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _compute_node_id(bootstrap.json())

    resp = await bootstrapped_client.get(f"/api/v1/graph/compute_node/{cn_id}/fs-records")
    assert resp.status_code == 200
    body = resp.json()
    assert "claude_error" in body["data"]["types"]


# ─── LIST ────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_fs_records_list_claude_errors(bootstrapped_client):
    """GET /fs-records/claude_error should return a list."""
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _compute_node_id(bootstrap.json())

    resp = await bootstrapped_client.get(f"/api/v1/graph/compute_node/{cn_id}/fs-records/claude_error")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "SUCCESS"
    assert isinstance(body["data"], list)


# ─── GET nonexistent ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_fs_records_get_nonexistent_claude_error(bootstrapped_client):
    """GET /fs-records/claude_error/nonexistent should 404."""
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _compute_node_id(bootstrap.json())

    resp = await bootstrapped_client.get(f"/api/v1/graph/compute_node/{cn_id}/fs-records/claude_error/nonexistent")
    assert resp.status_code == 404


# ─── CREATE + GET + UPDATE + DELETE ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_fs_records_crud_claude_error(bootstrapped_client):
    """Full CRUD lifecycle on a claude_error record."""
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _compute_node_id(bootstrap.json())
    base = f"/api/v1/graph/compute_node/{cn_id}/fs-records/claude_error"

    # CREATE — use unique fingerprint so repeated runs don't collide on disk
    fp = f"test-fp-{uuid.uuid4().hex[:8]}"
    payload = {
        "id": fp,
        "type": "claude_error",
        "name": "Test error",
        "fingerprint": fp,
        "error_category": "hook",
        "error_msg": "ImportError: no module named 'foo'",
        "hook": "TestHook",
        "event": "SessionStart",
        "root_cause": "ImportError: no module named 'foo'",
        "traceback": ["Traceback:", "ImportError: no module named 'foo'"],
        "occurrence_count": 1,
        "first_seen": "2026-01-01T00:00:00Z",
        "last_seen": "2026-01-01T00:00:00Z",
        "session_ids": ["session-123"],
        "last_session_id": "session-123",
        "last_jsonl_path": "/path/to/session-123.jsonl",
        "occurrences": [{"timestamp": "2026-01-01T00:00:00Z", "session_id": "session-123"}],
        "error_status": "open",
    }
    resp = await bootstrapped_client.post(base, json=payload)
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "SUCCESS"
    assert body["data"]["fingerprint"] == fp

    # GET
    resp = await bootstrapped_client.get(f"{base}/{fp}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "SUCCESS"
    assert body["data"]["error_status"] == "open"
    assert body["data"]["hook"] == "TestHook"

    # UPDATE
    resp = await bootstrapped_client.put(
        f"{base}/{fp}",
        json={"error_status": "ignored", "triaged_at": "2026-01-02T00:00:00Z"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "SUCCESS"
    assert body["data"]["error_status"] == "ignored"

    # Verify update persisted
    resp = await bootstrapped_client.get(f"{base}/{fp}")
    assert resp.json()["data"]["error_status"] == "ignored"

    # DELETE
    resp = await bootstrapped_client.delete(f"{base}/{fp}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "SUCCESS"

    # Verify deleted
    resp = await bootstrapped_client.get(f"{base}/{fp}")
    assert resp.status_code == 404
