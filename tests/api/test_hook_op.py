"""API integration tests for hook_op webhook dispatch.

Adapted from FlowPad: flowpad/hub/tests/api/test_resource_sync.py
Tests the hook_op v2 webhook envelope (unified CRUD + event + invoke + log dispatch).
"""

import pytest

LISTEN_URL = "/api/v1/webhook/listen"


def _envelope(payload: dict) -> dict:
    return {"webhook_type": "hook_op", "webhook_payload": payload}


# -- Task CRUD ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_hook_op_task_create(bootstrapped_client, user):
    """POST task create via hook_op dispatches to _reflect_entity."""
    payload = _envelope(
        {
            "type": "task",
            "id": "analysis-rs-test-1",
            "operation": "create",
            "data": {
                "title": "RS Task",
                "status": "in_progress",
            },
        }
    )

    response = await bootstrapped_client.post(LISTEN_URL, json=payload)
    assert response.status_code == 200, response.text
    data = response.json().get("data", {})
    assert data.get("action") in ("created", "updated")
    assert data.get("task_id") is not None


@pytest.mark.asyncio
async def test_hook_op_task_update(bootstrapped_client, user):
    """Create then update a task via hook_op."""
    create_payload = _envelope(
        {
            "type": "task",
            "id": "analysis-rs-test-2",
            "operation": "create",
            "data": {"title": "Original Title", "status": "in_progress"},
        }
    )
    resp1 = await bootstrapped_client.post(LISTEN_URL, json=create_payload)
    assert resp1.status_code == 200

    update_payload = _envelope(
        {
            "type": "task",
            "id": "analysis-rs-test-2",
            "operation": "update",
            "data": {"title": "Updated Title", "status": "completed"},
        }
    )
    resp2 = await bootstrapped_client.post(LISTEN_URL, json=update_payload)
    assert resp2.status_code == 200
    data = resp2.json().get("data", {})
    assert data.get("action") == "updated"


@pytest.mark.asyncio
async def test_hook_op_task_create_is_searchable(bootstrapped_client, user):
    """A webhook-created task is in FTS as soon as the listen route returns.

    ``_reflect_entity`` only calls ``entity.save()``; ``Entity.save()`` owns the
    FTS write for a ``db_only`` type with ``TypeInfo.fts_content`` (task:
    ``title``/``description``), so ``/fs-records/search`` must find the row
    without any separate index step (docs/data-management/listen-action.md,
    "FTS indexing").
    """
    token = "hookopftsprobe7f3a9c"
    payload = _envelope(
        {
            "type": "task",
            "id": "analysis-rs-test-fts",
            "operation": "create",
            "data": {"title": f"Searchable {token}", "status": "in_progress"},
        }
    )
    created = await bootstrapped_client.post(LISTEN_URL, json=payload)
    assert created.status_code == 200, created.text
    task_id = created.json()["data"]["task_id"]
    assert task_id

    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = bootstrap.json()["data"]["default_compute_node"]["id"]
    found = await bootstrapped_client.get(
        f"/api/v1/graph/compute_node/{cn_id}/fs-records/search?q={token}&record_type=task"
    )
    assert found.status_code == 200, found.text
    results = found.json()["data"]["results"]
    assert any(r["record_id"] == task_id for r in results), results


# -- Skill events -------------------------------------------------------------


@pytest.mark.asyncio
async def test_hook_op_skill_activated(bootstrapped_client, user):
    """Skill activated event via hook_op."""
    payload = _envelope(
        {
            "type": "skill",
            "id": "my-skill",
            "operation": "event",
            "data": {
                "event_name": "skill_activated",
                "event_data": {
                    "notification": {
                        "skill_name": "skillit",
                        "matched_keyword": "skillit",
                        "folder_path": "/tmp/test",
                    },
                },
            },
            "execution_scope": [{"type": "flow", "id": "flow-rs-1"}],
        }
    )

    response = await bootstrapped_client.post(LISTEN_URL, json=payload)
    assert response.status_code == 200
    data = response.json().get("data", {})
    assert data.get("status") == "received"


@pytest.mark.asyncio
async def test_hook_op_started_generating_skill(bootstrapped_client, user):
    """started_generating_skill event via hook_op."""
    payload = _envelope(
        {
            "type": "skill",
            "id": "gen-skill",
            "operation": "event",
            "data": {
                "event_name": "started_generating_skill",
                "event_data": {
                    "context": {
                        "skill_name": "my_skill",
                        "session_id": "sess-123",
                        "cwd": "/tmp/project",
                    },
                },
            },
        }
    )

    response = await bootstrapped_client.post(LISTEN_URL, json=payload)
    assert response.status_code == 200
    data = response.json().get("data", {})
    assert data.get("status") == "received"


@pytest.mark.asyncio
async def test_hook_op_skill_ready(bootstrapped_client, user):
    """skill_ready event via hook_op."""
    payload = _envelope(
        {
            "type": "skill",
            "id": "ready-skill",
            "operation": "event",
            "data": {
                "event_name": "skill_ready",
                "event_data": {
                    "context": {
                        "skill_name": "my_skill",
                        "session_id": "sess-456",
                    },
                },
            },
        }
    )

    response = await bootstrapped_client.post(LISTEN_URL, json=payload)
    assert response.status_code == 200
    data = response.json().get("data", {})
    assert data.get("status") == "received"


# -- Log events ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_hook_op_log_event(bootstrapped_client, user):
    """Log event is accepted and handled."""
    payload = _envelope(
        {
            "type": "log",
            "id": "log-1",
            "operation": "event",
            "data": {
                "event_name": "log_entry",
                "event_data": {
                    "context": {"level": "info"},
                },
            },
        }
    )

    response = await bootstrapped_client.post(LISTEN_URL, json=payload)
    assert response.status_code == 200
    data = response.json().get("data", {})
    assert data.get("status") == "received"


# -- Invoke operation ---------------------------------------------------------


@pytest.mark.asyncio
async def test_hook_op_invoke(bootstrapped_client, user):
    """INVOKE operation is accepted."""
    payload = _envelope(
        {
            "type": "mcp_event",
            "id": "invoke-1",
            "operation": "invoke",
            "data": {"element_type": "unknown", "flow_value": "test"},
        }
    )

    response = await bootstrapped_client.post(LISTEN_URL, json=payload)
    assert response.status_code == 200
    data = response.json().get("data", {})
    assert data.get("status") == "received"


# -- Log operation ------------------------------------------------------------


@pytest.mark.asyncio
async def test_hook_op_log_operation(bootstrapped_client, user):
    """LOG operation is accepted."""
    payload = _envelope(
        {
            "type": "debug",
            "id": "log-op-1",
            "operation": "log",
            "data": {"message": "something happened"},
        }
    )

    response = await bootstrapped_client.post(LISTEN_URL, json=payload)
    assert response.status_code == 200
    data = response.json().get("data", {})
    assert data.get("status") == "received"


# -- Validation ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_hook_op_invalid_event(bootstrapped_client, user):
    """EVENT without event_name in data should return a validation error."""
    payload = _envelope(
        {
            "type": "skill",
            "id": "bad-event",
            "operation": "event",
            "data": {"some_field": "no event_name"},
        }
    )

    response = await bootstrapped_client.post(LISTEN_URL, json=payload)
    assert response.status_code == 200
    body = response.json()
    # Should fail validation -- message field present with error info
    assert body.get("message") is not None
    assert "event_name" in body["message"]
