"""API tests for the server pieces the ``flow conversation`` CLI relies on:

* ``conversation-summary`` action → ``Conversation.summary()`` text.
* the relaxed ``add_message`` gate → a non-draft send made without cloud login
  is no longer refused; it is persisted locally as ``delivery_status=pending_send``.

These drive the real REST actions in-process and validate the effect on the
SDK layer (``FlowMessage.get_one`` / ``Conversation.get_one``).
"""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest

from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import DeliveryStatus, FlowMessage

pytestmark = pytest.mark.asyncio


async def _local_project_id(client) -> str:
    projects = (await client.get("/api/v1/graph/project")).json()["data"]
    return next(p for p in projects if p.get("uname") == "local")["id"]


async def _make_conversation(client) -> str:
    project_id = await _local_project_id(client)
    resp = await client.post(
        "/api/v1/graph/conversation-create",
        json={"project_id": project_id, "participants": [{"email": "tzahi@example.com", "name": "Tzahi"}]},
    )
    assert resp.json().get("status") == "SUCCESS", resp.text
    return resp.json()["data"]["conversation_id"]


def _force_login(monkeypatch, *, logged_in: bool) -> None:
    """Pin the send gate deterministically: not in Local mode, login = ``logged_in``.

    ``share_action`` re-imports ``is_logged_in`` per call (patch the source);
    ``notification_action`` binds it at module load (patch there too).
    """
    monkeypatch.setattr("flow_sdk.instance_settings.privacy_mode.is_local_mode", lambda: False)
    monkeypatch.setattr("flow_sdk.cli.auth.hub_login.is_logged_in", lambda: logged_in)
    monkeypatch.setattr("flow_sdk.app.actions.notification_action.is_logged_in", lambda: logged_in)


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_pending_send_persists_status_when_not_logged_in(bootstrapped_client, user, monkeypatch):
    """A real (non-draft) send without cloud login is saved, not refused, and
    stamped ``pending_send`` — both in the response and on the stored entity."""
    _force_login(monkeypatch, logged_in=False)
    client = bootstrapped_client
    conv_id = await _make_conversation(client)

    resp = await client.post(
        f"/api/v1/graph/conversation/{conv_id}/add_message",
        json={"text": "queued while logged out"},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["delivery_status"] == DeliveryStatus.PENDING_SEND.value
    fm_id = data["flow_message_id"]

    # SDK validation: the persisted row carries the pending status.
    fm = await FlowMessage.get_one({"id": fm_id})
    assert fm is not None
    assert fm.delivery_status == DeliveryStatus.PENDING_SEND.value
    assert fm.text == "queued while logged out"

    # It still lands in the conversation (count incremented).
    conv = (await client.get(f"/api/v1/graph/conversation/{conv_id}")).json()["data"]
    assert conv["message_count"] == 1


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_logged_in_local_conversation_send_is_created(bootstrapped_client, user, monkeypatch):
    """Logged in but a local-only conversation (remote=False) → no hub push, the
    message keeps the default ``created`` status (not pending_send)."""
    _force_login(monkeypatch, logged_in=True)
    client = bootstrapped_client
    conv_id = await _make_conversation(client)

    resp = await client.post(
        f"/api/v1/graph/conversation/{conv_id}/add_message",
        json={"text": "local send"},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["delivery_status"] == DeliveryStatus.CREATED.value

    fm = await FlowMessage.get_one({"id": data["flow_message_id"]})
    assert fm.delivery_status == DeliveryStatus.CREATED.value


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_add_message_git_share_config_reaches_background_upload(
    bootstrapped_client, user, monkeypatch
):
    """Git-backed shares are normal attachment sends whose body packer runs in
    git mode. This verifies the conversation action forwards the dialog's
    share_config through to the background upload task.
    """
    _force_login(monkeypatch, logged_in=True)
    client = bootstrapped_client
    conv_id = await _make_conversation(client)
    conv = await Conversation.get_one({"id": conv_id})
    conv.remote = True
    await conv.save()

    upload_calls: list[tuple[str, bool]] = []

    async def fake_upload(
        _fm,
        _conv_id,
        *,
        transfer_mode: str = "copy",
        create_bookmark: bool = False,
    ) -> None:
        upload_calls.append((transfer_mode, create_bookmark))

    tasks: list[asyncio.Task] = []
    real_create_task = asyncio.create_task

    def capture_task(coro):
        task = real_create_task(coro)
        tasks.append(task)
        return task

    monkeypatch.setattr(
        "flow_sdk.app.actions.notification_action._send_conversation_message_header",
        AsyncMock(return_value=True),
    )
    monkeypatch.setattr(
        "flow_sdk.app.actions.notification_action._upload_body_and_finalize",
        fake_upload,
    )
    monkeypatch.setattr(
        "flow_sdk.app.actions.notification_action.asyncio.create_task",
        capture_task,
    )

    resp = await client.post(
        f"/api/v1/graph/conversation/{conv_id}/add_message",
        json={
            "message": "shared git-backed app",
            "asset_references": ["artifact-11111111-1111-4111-8111-111111111111"],
            "share_config": {"transfer_mode": "git"},
        },
    )

    assert resp.status_code == 200, resp.text
    assert tasks, "body upload task was not scheduled"
    await asyncio.gather(*tasks)
    assert upload_calls == [("git", False)]


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_conversation_summary_action_renders_header_and_messages(
    bootstrapped_client, user, monkeypatch
):
    """``conversation-summary`` returns the header + one line per message."""
    _force_login(monkeypatch, logged_in=False)
    client = bootstrapped_client
    conv_id = await _make_conversation(client)

    for text in ("first message", "second message"):
        r = await client.post(
            f"/api/v1/graph/conversation/{conv_id}/add_message", json={"text": text}
        )
        assert r.json()["status"] == "SUCCESS", r.text

    resp = await client.post(
        "/api/v1/graph/conversation-summary", json={"conversation_id": conv_id}
    )
    assert resp.status_code == 200, resp.text
    summary = resp.json()["data"]["summary"]
    assert "Conversation:" in summary
    assert "Messages: 2" in summary
    assert "first message" in summary
    assert "second message" in summary
    # Participant roster appears in the header.
    assert "Tzahi" in summary


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_conversation_summary_missing_conversation(bootstrapped_client, user):
    resp = await bootstrapped_client.post(
        "/api/v1/graph/conversation-summary",
        json={"conversation_id": "does-not-exist"},
    )
    assert resp.status_code != 200 or resp.json()["status"] != "SUCCESS"
