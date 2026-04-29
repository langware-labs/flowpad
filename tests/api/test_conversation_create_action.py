"""Tests for the project-scoped conversation create action.

POST /api/v1/graph/conversation-create  — create Conversation under a Project
with a participants list. Each participant email is upserted as a User so the
contact list grows.
"""

from pathlib import Path

import pytest


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_conversation_create_under_project_upserts_participants(bootstrapped_client):
    # Bootstrap creates a @local Project with a real fs_storage_mount_path.
    projects = (await bootstrapped_client.get("/api/v1/graph/project")).json()["data"]
    local_project = next(p for p in projects if p.get("uname") == "local")
    project_id = local_project["id"]
    mount_path = local_project["fs_storage_mount_path"]

    response = await bootstrapped_client.post(
        "/api/v1/graph/conversation-create",
        json={
            "project_id": project_id,
            "participants": [
                {"email": "alice@example.com", "name": "Alice"},
                {"email": "bob@example.com"},
            ],
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "SUCCESS", body
    data = body["data"]
    assert data["project_id"] == project_id
    conv_id = data["conversation_id"]
    assert conv_id

    # Both participants now have a user_id (upserted as Users)
    parts = data["participants"]
    assert len(parts) == 2
    assert all(p["user_id"] for p in parts)
    assert {p["email"] for p in parts} == {"alice@example.com", "bob@example.com"}

    # The conversation row exists, has project_id, no task_id
    conv_resp = await bootstrapped_client.get(f"/api/v1/graph/conversation/{conv_id}")
    assert conv_resp.status_code == 200, conv_resp.text
    conv = conv_resp.json()["data"]
    assert conv["project_id"] == project_id
    assert not conv.get("task_id")  # absent or None — no Task created
    assert len(conv["participants"]) == 2

    # The conversation.jsonl file exists under the project's mount path
    conv_root = Path(mount_path) / "conversations"
    assert conv_root.exists(), f"expected {conv_root} to exist"
    matches = list(conv_root.glob(f"*-{conv_id[:8]}/conversation.jsonl"))
    assert matches, f"expected conversation.jsonl under {conv_root}, found: {list(conv_root.iterdir())}"

    # Both emails are now Users
    users = (await bootstrapped_client.get("/api/v1/graph/user")).json()["data"]
    emails = {u.get("email") for u in users}
    assert "alice@example.com" in emails
    assert "bob@example.com" in emails


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_conversation_create_rejects_missing_project_id(bootstrapped_client):
    response = await bootstrapped_client.post(
        "/api/v1/graph/conversation-create",
        json={"participants": [{"email": "x@y.com"}]},
    )
    assert response.status_code != 200 or response.json()["status"] != "SUCCESS"
    assert "project_id" in response.text.lower()


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_conversation_create_with_no_participants(bootstrapped_client):
    """Creating a conversation with no participants is allowed (empty contact list)."""
    projects = (await bootstrapped_client.get("/api/v1/graph/project")).json()["data"]
    project_id = next(p for p in projects if p.get("uname") == "local")["id"]

    response = await bootstrapped_client.post(
        "/api/v1/graph/conversation-create",
        json={"project_id": project_id, "participants": []},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "SUCCESS"
    assert body["data"]["participants"] == []
