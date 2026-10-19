"""conversation-message-sync must not ask the hub about local-only conversations.

A Conversation with ``remote=False`` has no hub counterpart: fetching its
messages from the hub is guaranteed to fail, and the hub answers entity-miss
with a 401 whose broadcast surfaces as a spurious "Cloud sign-in expired"
toast (RCA 2026-07-06). The action must short-circuit on the local ``remote``
flag and report the skip instead of issuing the hub request.
"""

from types import SimpleNamespace

import pytest

from flow_sdk.app.actions import flow_message_action
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType


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
async def test_message_sync_unknown_conversation_still_404s(bootstrapped_client, monkeypatch):
    async def missing_hub_conversation(*args, **kwargs):
        return None

    monkeypatch.setattr(flow_message_action, "hub_get", missing_hub_conversation)
    response = await bootstrapped_client.post(
        "/api/v1/graph/conversation-message-sync",
        json={"conversation_id": "00000000-0000-4000-8000-000000000000"},
    )
    body = response.json()
    assert body["status"] == "FAIL"
    assert "not found" in body["message"]


@pytest.mark.asyncio
async def test_message_sync_materializes_exact_assigned_conversation_after_missed_bridge_frame(
    bootstrapped_client,
    monkeypatch,
):
    conv_id = "10000000-0000-4000-8000-000000000001"
    calls: list[tuple] = []

    async def fake_hub_get(entity_type, entity_id=None, *args, **kwargs):
        calls.append(("hub_get", entity_type, entity_id))
        return {"id": conv_id, "title": "Assigned while disconnected", "participants": []}

    async def fake_upsert(hub_conv, someone_typeid, *, existing):
        calls.append(("upsert", hub_conv["id"], existing))
        return SimpleNamespace(id=conv_id, remote=True)

    async def fake_fetch_messages(target_id, someone_typeid):
        calls.append(("messages", target_id))

    async def fake_sync_context(target_id, someone_typeid):
        calls.append(("context", target_id))

    monkeypatch.setattr(flow_message_action, "hub_get", fake_hub_get)
    monkeypatch.setattr(flow_message_action, "_upsert_hub_conversation_metadata", fake_upsert)
    monkeypatch.setattr(flow_message_action, "_fetch_conversation_messages", fake_fetch_messages)
    monkeypatch.setattr(flow_message_action, "_sync_shared_context_subtree", fake_sync_context)

    response = await bootstrapped_client.post(
        "/api/v1/graph/conversation-message-sync",
        json={"conversation_id": conv_id},
    )

    assert response.status_code == 200, response.text
    assert response.json()["data"] == {"conversation_id": conv_id}
    assert calls == [
        ("hub_get", BuiltinEntityType.CONVERSATION, conv_id),
        ("upsert", conv_id, None),
        ("messages", conv_id),
        ("context", conv_id),
    ]
