"""API tests for Shell entity lifecycle.

Tests CRUD operations via the graph API for Shell entities.
"""

import pytest

from flow_sdk.responses.response import ApiResponse


@pytest.mark.asyncio
async def test_create_shell_session_entity(bootstrapped_client):
    """POST /graph/shell_session creates entity."""
    response = await bootstrapped_client.post(
        "/api/v1/graph/shell",
        json={
            "name": "Test Shell",
            "status": "created",
            "compute_node_id": "test-node-1",
            "workdir": "/tmp",
            "tab_order": 0,
        },
    )
    assert response.status_code == 200, response.text
    res = ApiResponse(**response.json())
    assert res.status == "SUCCESS"
    entity = res.data
    assert entity.get("type") == "shell"
    assert entity.get("name") == "Test Shell"
    assert entity.get("status") == "created"
    assert entity.get("compute_node_id") == "test-node-1"
    assert entity.get("workdir") == "/tmp"


@pytest.mark.asyncio
async def test_read_shell_session_entity(bootstrapped_client):
    """GET /graph/shell_session/{id} returns entity."""
    # Create first
    create_resp = await bootstrapped_client.post(
        "/api/v1/graph/shell",
        json={"name": "Read Test", "status": "created"},
    )
    assert create_resp.status_code == 200
    created = ApiResponse(**create_resp.json()).data
    entity_id = created["id"]

    # Read back
    response = await bootstrapped_client.get(f"/api/v1/graph/shell/{entity_id}")
    assert response.status_code == 200, response.text
    res = ApiResponse(**response.json())
    assert res.status == "SUCCESS"
    assert res.data.get("name") == "Read Test"
    assert res.data.get("id") == entity_id


@pytest.mark.asyncio
async def test_close_shell_session(bootstrapped_client):
    """POST /graph/shell_session/{id}/close sets status=closed."""
    # Create entity
    create_resp = await bootstrapped_client.post(
        "/api/v1/graph/shell",
        json={"name": "Close Test", "status": "created"},
    )
    assert create_resp.status_code == 200
    created = ApiResponse(**create_resp.json()).data
    entity_id = created["id"]

    # Close it
    response = await bootstrapped_client.post(
        f"/api/v1/graph/shell/{entity_id}/close",
    )
    assert response.status_code == 200, response.text
    res = ApiResponse(**response.json())
    assert res.status == "SUCCESS"

    # Verify entity was deleted (read should return 404/FAIL)
    read_resp = await bootstrapped_client.get(f"/api/v1/graph/shell/{entity_id}")
    assert read_resp.status_code in (200, 404)
    read_res = ApiResponse(**read_resp.json())
    assert read_res.status == "FAIL" or read_res.data is None


@pytest.mark.asyncio
async def test_update_display(bootstrapped_client):
    """POST /graph/shell_session/{id}/update-display updates fields."""
    # Create entity
    create_resp = await bootstrapped_client.post(
        "/api/v1/graph/shell",
        json={"name": "Display Test", "status": "created"},
    )
    assert create_resp.status_code == 200
    created = ApiResponse(**create_resp.json()).data
    entity_id = created["id"]

    # Update display
    response = await bootstrapped_client.post(
        f"/api/v1/graph/shell/{entity_id}/update-display",
        json={"name": "Renamed Tab", "tab_order": 3},
    )
    assert response.status_code == 200, response.text
    res = ApiResponse(**response.json())
    assert res.status == "SUCCESS"
    assert res.data.get("name") == "Renamed Tab"
    assert res.data.get("tab_order") == 3


@pytest.mark.asyncio
async def test_list_shell_sessions_entity_query(bootstrapped_client):
    """list-shell-sessions returns only non-closed sessions via entity query."""
    # Create two sessions with status="created" (not "running") to avoid zombie detection
    resp1 = await bootstrapped_client.post(
        "/api/v1/graph/shell",
        json={"name": "Session A", "status": "created"},
    )
    assert resp1.status_code == 200
    resp2 = await bootstrapped_client.post(
        "/api/v1/graph/shell",
        json={"name": "Session B", "status": "created"},
    )
    assert resp2.status_code == 200

    # List via compute_node action
    list_resp = await bootstrapped_client.get(
        "/api/v1/graph/compute_node/@local/list-shell-sessions",
    )
    assert list_resp.status_code == 200, list_resp.text
    res = ApiResponse(**list_resp.json())
    assert res.status == "SUCCESS"
    names = [s.get("name") for s in res.data]
    assert "Session A" in names
    assert "Session B" in names


@pytest.mark.asyncio
async def test_close_shell_session_excluded_from_list(bootstrapped_client):
    """Closed sessions don't appear in list-shell-sessions."""
    # Create a session
    create_resp = await bootstrapped_client.post(
        "/api/v1/graph/shell",
        json={"name": "To Close", "status": "running"},
    )
    assert create_resp.status_code == 200
    entity_id = ApiResponse(**create_resp.json()).data["id"]

    # Close it
    close_resp = await bootstrapped_client.post(
        f"/api/v1/graph/shell/{entity_id}/close",
    )
    assert close_resp.status_code == 200

    # List should not include the closed session
    list_resp = await bootstrapped_client.get(
        "/api/v1/graph/compute_node/@local/list-shell-sessions",
    )
    assert list_resp.status_code == 200
    res = ApiResponse(**list_resp.json())
    ids = [s.get("id") for s in res.data]
    assert entity_id not in ids


@pytest.mark.asyncio
async def test_close_all_then_list_empty(bootstrapped_client):
    """Close All -> list -> no sessions (the bug scenario)."""
    # Create sessions
    ids = []
    for name in ["Tab 1", "Tab 2", "Tab 3"]:
        resp = await bootstrapped_client.post(
            "/api/v1/graph/shell",
            json={"name": name, "status": "running"},
        )
        assert resp.status_code == 200
        ids.append(ApiResponse(**resp.json()).data["id"])

    # Close all
    for eid in ids:
        close_resp = await bootstrapped_client.post(
            f"/api/v1/graph/shell/{eid}/close",
        )
        assert close_resp.status_code == 200

    # List should be empty (no running sessions)
    list_resp = await bootstrapped_client.get(
        "/api/v1/graph/compute_node/@local/list-shell-sessions",
    )
    assert list_resp.status_code == 200
    res = ApiResponse(**list_resp.json())
    # All sessions we created are closed, so none should appear
    our_ids = set(ids)
    remaining = [s for s in res.data if s.get("id") in our_ids]
    assert len(remaining) == 0


@pytest.mark.asyncio
async def test_create_shell_entity_fields(bootstrapped_client):
    """POST /graph/shell creates a Shell entity with the correct name and status.

    record_data_ref has been removed — it is no longer an accepted API field.
    Shell entities are created via the graph API; write-through to ShellRecord
    happens separately via Shell.from_record().
    """
    response = await bootstrapped_client.post(
        "/api/v1/graph/shell",
        json={
            "name": "Test Shell",
            "status": "idle",
        },
    )
    assert response.status_code == 200, response.text
    res = ApiResponse(**response.json())
    assert res.status == "SUCCESS"
    assert res.data.get("name") == "Test Shell"
    assert res.data.get("status") == "idle"
    # record_data_ref is no longer an API field
    assert res.data.get("record_data_ref") is None


@pytest.mark.asyncio
async def test_run_command(bootstrapped_client):
    """POST /graph/shell_session/{id}/run executes command and returns output."""
    # Create entity
    create_resp = await bootstrapped_client.post(
        "/api/v1/graph/shell",
        json={"name": "Run Test", "status": "idle"},
    )
    assert create_resp.status_code == 200
    created = ApiResponse(**create_resp.json()).data
    entity_id = created["id"]

    # Run a command
    response = await bootstrapped_client.post(
        f"/api/v1/graph/shell/{entity_id}/run",
        json={"command": "echo hello"},
    )
    assert response.status_code == 200, response.text
    res = ApiResponse(**response.json())
    assert res.status == "SUCCESS"
    assert res.data["stdout"].strip() == "hello"
    assert res.data["exit_code"] == 0


@pytest.mark.asyncio
async def test_set_env_persists_on_entity(bootstrapped_client):
    """POST /graph/shell_session/{id}/set-env stores vars on the entity."""
    # Create entity
    create_resp = await bootstrapped_client.post(
        "/api/v1/graph/shell",
        json={"name": "Env Test", "status": "idle"},
    )
    assert create_resp.status_code == 200
    created = ApiResponse(**create_resp.json()).data
    entity_id = created["id"]

    # Set env vars
    response = await bootstrapped_client.post(
        f"/api/v1/graph/shell/{entity_id}/set-env",
        json={"vars": {"FOO": "bar"}},
    )
    assert response.status_code == 200, response.text
    res = ApiResponse(**response.json())
    assert res.status == "SUCCESS"
    assert "FOO" in res.data["vars"]

    # Verify via GET
    read_resp = await bootstrapped_client.get(f"/api/v1/graph/shell/{entity_id}")
    assert read_resp.status_code == 200
    read_res = ApiResponse(**read_resp.json())
    assert read_res.data.get("env") == {"FOO": "bar"}
