"""Tests for the project-scoped conversation create action.

POST /api/v1/graph/conversation-create  — create Conversation under a Project
with a participants list. Each participant email is upserted as a User so the
contact list grows.

Conversations are standard records: their data file lives at the canonical
records-data location `<records_data_root>/conversation/conversation-@<id>/conversation.jsonl`,
NOT inside the project's filesystem mount. These tests pin that contract.
"""

import json
from pathlib import Path

import pytest

from flow_sdk.fs_records.conversation_record import ConversationRecord
from flow_sdk.fs_store import RecordType
from flow_sdk.fs_store.record import get_default_records_data_root, record_stem


def _first_flow_message_id(message_ids) -> str:
    if isinstance(message_ids, str):
        message_ids = json.loads(message_ids)
    assert message_ids
    typeid = message_ids[0]
    if isinstance(typeid, dict):
        typeid = typeid["typeid"]
    assert typeid.startswith("flow_message-")
    return typeid.removeprefix("flow_message-")


def _stub_bundle_hub(monkeypatch, *, email_error: str | None = None) -> None:
    from flow_sdk.app.actions import notification_action
    from flow_sdk.db.drivers.db_base_record import BuiltinEntityType

    async def fake_hub_post(entity_type, payload, *args, **kwargs):
        assert entity_type == BuiltinEntityType.FLOW_MESSAGE
        assert kwargs.get("action") == "send"
        data = {"flow_message_id": payload["flow_message_id"]}
        if email_error:
            data["email_error"] = email_error
        return data

    async def fake_upload_bundle_to_hub(hub_flow_message_id, fm, task_title):
        return None

    monkeypatch.setattr(notification_action, "hub_base_url", lambda: "http://hub.test")
    monkeypatch.setattr(notification_action, "hub_post", fake_hub_post)
    monkeypatch.setattr(notification_action, "_upload_bundle_to_hub", fake_upload_bundle_to_hub)


# ---------------------------------------------------------------------------
# Existing happy paths — updated to the new on-disk contract.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_conversation_create_under_project_upserts_participants(bootstrapped_client):
    """Create + verify participants land as Users + jsonl file at standard path."""
    projects = (await bootstrapped_client.get("/api/v1/graph/project")).json()["data"]
    local_project = next(p for p in projects if p.get("uname") == "local")
    project_id = local_project["id"]

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

    # Participants are stored exactly as the caller provided them. The address
    # book may learn contacts, but it must not rewrite Conversation.participants.
    parts = data["participants"]
    assert parts == [
        {"email": "alice@example.com", "name": "Alice"},
        {"email": "bob@example.com"},
    ]

    # The conversation row exists, has project_id, no task_id.
    conv_resp = await bootstrapped_client.get(f"/api/v1/graph/conversation/{conv_id}")
    assert conv_resp.status_code == 200, conv_resp.text
    conv = conv_resp.json()["data"]
    assert conv["project_id"] == project_id
    assert not conv.get("task_id")
    assert len(conv["participants"]) == 2

    # Standard records-data location. ``data_path`` is now a derived
    # @property on ``Conversation`` (not a stored field), so it isn't part
    # of the API payload — we just verify the canonical path exists on disk.
    expected_jsonl = ConversationRecord.default_jsonl_path(conv_id)
    assert expected_jsonl.exists(), f"expected {expected_jsonl} to exist"

    # Both emails are now Users in the contact list.
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


# ---------------------------------------------------------------------------
# New positive cases — pin the standard-records-data behavior.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_jsonl_lands_in_records_data_root(bootstrapped_client):
    """The on-disk jsonl is rooted at `<records_data_root>/conversation/`."""
    projects = (await bootstrapped_client.get("/api/v1/graph/project")).json()["data"]
    project_id = next(p for p in projects if p.get("uname") == "local")["id"]

    resp = await bootstrapped_client.post(
        "/api/v1/graph/conversation-create",
        json={"project_id": project_id, "participants": []},
    )
    conv_id = resp.json()["data"]["conversation_id"]

    expected_dir = (
        get_default_records_data_root()
        / RecordType.CONVERSATION
        / record_stem(RecordType.CONVERSATION, conv_id)
    )
    expected_jsonl = expected_dir / "conversation.jsonl"
    assert expected_jsonl.exists()
    # Spot the parent layout — `<root>/conversation/conversation-@<id>/`.
    assert expected_dir.parent.name == RecordType.CONVERSATION
    assert expected_dir.name == f"{RecordType.CONVERSATION}-@{conv_id}"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_append_conversation_writes_into_records_data_jsonl(bootstrapped_client):
    """`append-conversation` with `conversation_id` lands in the records-data file."""
    projects = (await bootstrapped_client.get("/api/v1/graph/project")).json()["data"]
    project_id = next(p for p in projects if p.get("uname") == "local")["id"]

    create = await bootstrapped_client.post(
        "/api/v1/graph/conversation-create",
        json={"project_id": project_id, "participants": []},
    )
    conv_id = create.json()["data"]["conversation_id"]

    append = await bootstrapped_client.post(
        "/api/v1/graph/notification/append-conversation",
        json={"conversation_id": conv_id, "message": "hello world"},
    )
    assert append.status_code == 200, append.text
    assert append.json()["status"] == "SUCCESS"

    # The pointer line lands in the records-data-rooted jsonl.
    jsonl_path = ConversationRecord.default_jsonl_path(conv_id)
    assert jsonl_path.exists()
    contents = jsonl_path.read_text(encoding="utf-8")
    assert append.json()["data"]["flow_message_id"] in contents

    conv = (await bootstrapped_client.get(f"/api/v1/graph/conversation/{conv_id}")).json()["data"]
    assert conv["message_count"] == 1


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_conversation_start_bundle_keeps_initial_message_as_flow_message(
    bootstrapped_client,
    monkeypatch,
):
    """Starting a cross-user conversation creates a FlowMessage, not a Notification."""
    from flow_sdk.builtin.flow_message import FlowMessage
    from flow_sdk.core.network.connection import Notification

    _stub_bundle_hub(monkeypatch)

    projects = (await bootstrapped_client.get("/api/v1/graph/project")).json()["data"]
    project_id = next(p for p in projects if p.get("uname") == "local")["id"]
    marker = "hi bob regression-success"

    response = await bootstrapped_client.post(
        "/api/v1/graph/conversation-start-bundle",
        json={
            "recipient_id": "bob@local.test",
            "message": marker,
            "project_id": project_id,
            "sender_name": "Local Tester",
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "SUCCESS", body
    data = body["data"]
    assert data["conversation_id"]
    assert data["notification_id"] is None

    conv = (
        await bootstrapped_client.get(
            f"/api/v1/graph/conversation/{data['conversation_id']}"
        )
    ).json()["data"]
    assert conv["message_count"] == 1
    message_id = _first_flow_message_id(conv["message_ids"])

    fm = await FlowMessage.get_one({"id": message_id})
    assert fm is not None
    assert fm.text == marker
    assert fm.conversation_id == data["conversation_id"]

    overwritten = await Notification.get_one({"id": message_id})
    assert overwritten is None


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_conversation_start_bundle_uses_cloud_participant_ids(
    bootstrapped_client,
    monkeypatch,
):
    """Cross-user start uses cloud sender id and Participant[] ids."""
    from flow_sdk.builtin.flow_message import FlowMessage
    from flow_sdk.builtin.user import User

    _stub_bundle_hub(monkeypatch)

    async def fake_current_sender_participant(cls, override_name=None):
        return {
            "user_id": "11111111-1111-4111-8111-111111111111",
            "name": "Alice",
            "email": "alice@local.test",
        }

    monkeypatch.setattr(
        User,
        "current_sender_participant",
        classmethod(fake_current_sender_participant),
    )

    marker = "hi bob participant ids"
    response = await bootstrapped_client.post(
        "/api/v1/graph/conversation-start-bundle",
        json={
            "participants": [
                {
                    "user_id": "22222222-2222-4222-8222-222222222222",
                    "name": "Bob",
                    "email": "bob@local.test",
                }
            ],
            "message": marker,
        },
    )

    assert response.status_code == 200, response.text
    data = response.json()["data"]
    conv = (
        await bootstrapped_client.get(
            f"/api/v1/graph/conversation/{data['conversation_id']}"
        )
    ).json()["data"]
    participants = {p["user_id"]: p for p in conv["participants"]}
    assert participants["11111111-1111-4111-8111-111111111111"]["name"] == "Alice"
    assert participants["11111111-1111-4111-8111-111111111111"]["email"] == "alice@local.test"
    assert participants["22222222-2222-4222-8222-222222222222"]["name"] == "Bob"
    assert participants["22222222-2222-4222-8222-222222222222"]["email"] == "bob@local.test"

    fm = await FlowMessage.get_one({"id": _first_flow_message_id(conv["message_ids"])})
    assert fm is not None
    assert fm.sender_id == "11111111-1111-4111-8111-111111111111"
    assert fm.sender_name == "Alice"
    assert fm.receiver_address == "22222222-2222-4222-8222-222222222222"
    assert fm.receiver_address_type == "id"

    bob = await User.get_one({"email": "bob@local.test"})
    assert bob is not None
    assert bob.name == "Bob"
    assert bob.email == "bob@local.test"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_conversation_start_bundle_email_failure_uses_fresh_notification_id(
    bootstrapped_client,
    monkeypatch,
):
    """Email failure creates a separate local Notification without overwriting the message."""
    from flow_sdk.builtin.flow_message import FlowMessage
    from flow_sdk.core.network.connection import Notification

    _stub_bundle_hub(monkeypatch, email_error="smtp rejected recipient")

    projects = (await bootstrapped_client.get("/api/v1/graph/project")).json()["data"]
    project_id = next(p for p in projects if p.get("uname") == "local")["id"]
    marker = "hi bob regression-email-failure"

    response = await bootstrapped_client.post(
        "/api/v1/graph/conversation-start-bundle",
        json={
            "recipient_id": "bob-failure@local.test",
            "message": marker,
            "project_id": project_id,
            "sender_name": "Local Tester",
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "SUCCESS", body
    data = body["data"]
    assert data["email_error"] == "smtp rejected recipient"
    assert data["notification_id"]

    conv = (
        await bootstrapped_client.get(
            f"/api/v1/graph/conversation/{data['conversation_id']}"
        )
    ).json()["data"]
    message_id = _first_flow_message_id(conv["message_ids"])
    assert data["notification_id"] != message_id

    fm = await FlowMessage.get_one({"id": message_id})
    assert fm is not None
    assert fm.text == marker

    failure_notification = await Notification.get_one({"id": data["notification_id"]})
    assert failure_notification is not None
    assert failure_notification.metadata["email_error"] == "smtp rejected recipient"

    overwritten = await Notification.get_one({"id": message_id})
    assert overwritten is None


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_two_creates_yield_two_distinct_records_data_dirs(bootstrapped_client):
    """Each Conversation gets its own `conversation-@<id>/` directory."""
    projects = (await bootstrapped_client.get("/api/v1/graph/project")).json()["data"]
    project_id = next(p for p in projects if p.get("uname") == "local")["id"]

    ids: list[str] = []
    for _ in range(2):
        resp = await bootstrapped_client.post(
            "/api/v1/graph/conversation-create",
            json={"project_id": project_id, "participants": []},
        )
        ids.append(resp.json()["data"]["conversation_id"])

    a, b = (ConversationRecord.default_data_dir(i) for i in ids)
    assert a != b
    assert a.exists() and b.exists()
    assert a.parent == b.parent  # both under <root>/conversation/


# ---------------------------------------------------------------------------
# Negative — regression bars for the bugs that motivated this change.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_jsonl_path_not_under_project_mount(bootstrapped_client):
    """Conversation jsonl is NEVER inside the project's filesystem mount."""
    projects = (await bootstrapped_client.get("/api/v1/graph/project")).json()["data"]
    local = next(p for p in projects if p.get("uname") == "local")
    project_id = local["id"]
    mount_path = Path(local["fs_storage_mount_path"]).resolve()

    resp = await bootstrapped_client.post(
        "/api/v1/graph/conversation-create",
        json={"project_id": project_id, "participants": []},
    )
    conv_id = resp.json()["data"]["conversation_id"]
    jsonl = ConversationRecord.default_jsonl_path(conv_id).resolve()

    assert mount_path not in jsonl.parents, (
        f"jsonl {jsonl} unexpectedly lives under project mount {mount_path}"
    )


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_no_conversations_dir_created_under_project_mount(bootstrapped_client):
    """We don't create the legacy `<project_mount>/conversations/<slug>-<id8>/` tree at all.

    This guards against any leftover code path that re-introduces the
    project-mount layout.
    """
    projects = (await bootstrapped_client.get("/api/v1/graph/project")).json()["data"]
    local = next(p for p in projects if p.get("uname") == "local")
    project_id = local["id"]
    mount_path = Path(local["fs_storage_mount_path"]).resolve()

    resp = await bootstrapped_client.post(
        "/api/v1/graph/conversation-create",
        json={"project_id": project_id, "participants": []},
    )
    conv_id = resp.json()["data"]["conversation_id"]

    legacy_root = mount_path / "conversations"
    if legacy_root.exists():
        # The directory may pre-exist from earlier-feature data; what matters is
        # that THIS conversation didn't write there.
        assert not list(legacy_root.glob(f"*-{conv_id[:8]}/conversation.jsonl")), (
            f"Found a legacy-layout dir for conv {conv_id} at {legacy_root}"
        )


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_create_under_system_project_does_not_touch_sdk_tree(bootstrapped_client):
    """The flowpad_assistant project's mount is the SDK source tree.

    Old handler joined paths from `fs_storage_mount_path` and would have
    written user data into `flow_sdk/system_projects/flowpad_assistant/`.
    The new handler must not — verify we land in records_data instead.
    """
    projects = (
        await bootstrapped_client.get("/api/v1/graph/project?include_system=true")
    ).json()["data"]
    assistant = next((p for p in projects if p.get("uname") == "flowpad_assistant"), None)
    if not assistant:
        pytest.skip("Flowpad Assistant system project not registered on this instance.")

    project_id = assistant["id"]
    mount_path = Path(assistant["fs_storage_mount_path"]).resolve()

    resp = await bootstrapped_client.post(
        "/api/v1/graph/conversation-create",
        json={"project_id": project_id, "participants": []},
    )
    assert resp.status_code == 200, resp.text
    conv_id = resp.json()["data"]["conversation_id"]

    jsonl = ConversationRecord.default_jsonl_path(conv_id).resolve()
    assert mount_path not in jsonl.parents
    assert "system_projects" not in jsonl.parts


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_directory_uses_canonical_record_stem_not_slug(bootstrapped_client):
    """The created folder uses the standard `conversation-@<id>` stem.

    Earlier the handler built a slug from participant emails, leaking
    addresses into filesystem paths. Verify the stem is canonical.
    """
    projects = (await bootstrapped_client.get("/api/v1/graph/project")).json()["data"]
    project_id = next(p for p in projects if p.get("uname") == "local")["id"]

    resp = await bootstrapped_client.post(
        "/api/v1/graph/conversation-create",
        json={
            "project_id": project_id,
            "participants": [{"email": "leak-check@example.com"}],
        },
    )
    conv_id = resp.json()["data"]["conversation_id"]

    parent_dir = ConversationRecord.default_jsonl_path(conv_id).parent
    assert parent_dir.name == f"{RecordType.CONVERSATION}-@{conv_id}"
    assert "leak-check" not in parent_dir.name
    assert "@" not in parent_dir.name.replace("-@", "")  # only the canonical separator
