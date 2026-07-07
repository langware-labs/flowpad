"""conversation-message-sync must not ask the hub about local-only conversations.

A Conversation with ``remote=False`` has no hub counterpart: fetching its
messages from the hub is guaranteed to fail, and the hub answers entity-miss
with a 401 whose broadcast surfaces as a spurious "Cloud sign-in expired"
toast (RCA 2026-07-06). The action must short-circuit on the local ``remote``
flag and report the skip instead of issuing the hub request.
"""

import pytest


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_message_sync_skips_local_only_conversation(bootstrapped_client):
    projects = (await bootstrapped_client.get("/api/v1/graph/project")).json()["data"]
    local_project = next(p for p in projects if p.get("uname") == "local")

    created = await bootstrapped_client.post(
        "/api/v1/graph/conversation-create",
        json={"project_id": local_project["id"], "participants": []},
    )
    assert created.status_code == 200, created.text
    conv_id = created.json()["data"]["conversation_id"]

    # Freshly created, never shared: the row is local-only (remote=False).
    conv = (await bootstrapped_client.get(f"/api/v1/graph/conversation/{conv_id}")).json()["data"]
    assert conv["remote"] is False

    response = await bootstrapped_client.post(
        "/api/v1/graph/conversation-message-sync",
        json={"conversation_id": conv_id},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "SUCCESS", body
    # The skip marker is the contract: it proves the action returned before
    # any hub fetch rather than succeeding around a failed/naive hub call.
    assert body["data"] == {"conversation_id": conv_id, "skipped": "local-only"}


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_message_sync_unknown_conversation_still_404s(bootstrapped_client):
    response = await bootstrapped_client.post(
        "/api/v1/graph/conversation-message-sync",
        json={"conversation_id": "00000000-0000-4000-8000-000000000000"},
    )
    body = response.json()
    assert body["status"] == "FAIL"
    assert "not found" in body["message"]
